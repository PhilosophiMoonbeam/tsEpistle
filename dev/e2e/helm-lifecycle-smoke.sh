#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE_REPOSITORY:?WIKI_TEST_IMAGE_REPOSITORY is required}"
: "${WIKI_TEST_IMAGE_TAG:?WIKI_TEST_IMAGE_TAG is required}"
: "${WIKI_TEST_PREVIOUS_IMAGE:?WIKI_TEST_PREVIOUS_IMAGE is required}"
: "${POSTGRES_TEST_IMAGE_REPOSITORY:?POSTGRES_TEST_IMAGE_REPOSITORY is required}"
: "${POSTGRES_TEST_IMAGE_TAG:?POSTGRES_TEST_IMAGE_TAG is required}"

RELEASE=wiki
NAMESPACE=wiki-lifecycle
APP=wiki-lifecycle
ADMIN_EMAIL=helm-lifecycle@example.com
ADMIN_PASSWORD=HelmLifecycle123!
CANDIDATE_IMAGE="$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG"
if [[ "$WIKI_TEST_PREVIOUS_IMAGE" =~ ^(.+):([^/@]+)@(sha256:[0-9a-f]{64})$ ]]; then
  PREVIOUS_IMAGE_REPOSITORY=${BASH_REMATCH[1]}
  PREVIOUS_IMAGE_TAG=${BASH_REMATCH[2]}
  PREVIOUS_IMAGE_DIGEST=${BASH_REMATCH[3]}
else
  echo 'WIKI_TEST_PREVIOUS_IMAGE must be an immutable tagged digest (repository:tag@sha256:digest).' >&2
  exit 1
fi
INITIAL_IMAGE="$PREVIOUS_IMAGE_REPOSITORY@$PREVIOUS_IMAGE_DIGEST"

if ! INITIAL_IMAGE_REVISION=$(docker image inspect --format '{{.Id}}' "$WIKI_TEST_PREVIOUS_IMAGE" 2>/dev/null); then
  echo "Supported previous-release image is not resolved locally: $WIKI_TEST_PREVIOUS_IMAGE" >&2
  exit 1
fi
if ! CANDIDATE_IMAGE_REVISION=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE" 2>/dev/null); then
  echo "Candidate image is not resolved locally: $CANDIDATE_IMAGE" >&2
  exit 1
fi
if [[ ! "$INITIAL_IMAGE_REVISION" =~ ^sha256:[0-9a-f]{64}$ || ! "$CANDIDATE_IMAGE_REVISION" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'Application images did not resolve to immutable Docker image revisions.' >&2
  exit 1
fi
if [ "$INITIAL_IMAGE_REVISION" = "$CANDIDATE_IMAGE_REVISION" ]; then
  echo "Previous release and candidate resolve to the same application revision: $INITIAL_IMAGE_REVISION" >&2
  exit 1
fi
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-wiki-lifecycle}"
APPLICATION_CONTAINER=
UPGRADE_LOG=
port_forward_pid=

cleanup() {
  if [ "${lifecycle_succeeded:-false}" != true ]; then
    kubectl --namespace "$NAMESPACE" get all,pvc 2>/dev/null || true
    kubectl --namespace "$NAMESPACE" describe pods 2>/dev/null || true
    kubectl --namespace "$NAMESPACE" logs deployment/"$APP" --all-containers 2>/dev/null || true
  fi
  if [ -n "${port_forward_pid:-}" ]; then
    kill "$port_forward_pid" >/dev/null 2>&1 || true
    wait "$port_forward_pid" 2>/dev/null || true
  fi
  if [ -n "${UPGRADE_LOG:-}" ]; then
    rm -f "$UPGRADE_LOG"
  fi
  helm uninstall "$RELEASE" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

app_request() {
  kubectl --namespace "$NAMESPACE" exec deployment/"$APP" -- curl \
    --fail --silent --show-error "$@"
}

login() {
  local response
  response=$(app_request \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
    http://127.0.0.1:3000/_api/auth/login)
  printf '%s' "$response" | jq --exit-status --raw-output \
    '.jwt | select(type == "string" and length > 0)'
}

wait_for_login() {
  local jwt
  for _ in {1..90}; do
    if jwt=$(login 2>/dev/null); then
      printf '%s' "$jwt"
      return 0
    fi
    sleep 2
  done
  echo 'Timed out waiting for Wiki authentication after setup or rollout.' >&2
  return 1
}

assert_page() {
  local token=$1
  local page_id=$2
  local response
  response=$(app_request --header "Authorization: Bearer $token" \
    "http://127.0.0.1:3000/_api/pages/$page_id")
  printf '%s' "$response" | jq --exit-status \
    '.path == "helm-lifecycle" and .title == "Helm lifecycle"' >/dev/null
}

assert_no_mixed_application_versions() {
  local mixed_versions
  if ! mixed_versions=$(kubectl --namespace "$NAMESPACE" get pods \
    -l "app.kubernetes.io/instance=$RELEASE" --output json | jq --compact-output \
    --arg container "$APPLICATION_CONTAINER" '
      [.items[]
        | select(.status.phase != "Succeeded" and .status.phase != "Failed")
        | {
            pod: .metadata.name,
            image: ([.spec.containers[]
              | select(.name == $container)
              | .image][0])
          }
        | select(.image != null)] as $pods
      | ($pods | map(.image) | unique) as $images
      | if ($images | length) > 1 then {images: $images, pods: $pods} else empty end
    '); then
    echo 'Unable to inspect application pod versions during the Helm upgrade.' >&2
    return 1
  fi
  if [ -n "$mixed_versions" ]; then
    echo "Old and new application pods overlapped during the Helm upgrade: $mixed_versions" >&2
    return 1
  fi
}

assert_service_port_forward_health() {
  local port_forward_log
  port_forward_log=$(mktemp)
  kubectl --namespace "$NAMESPACE" port-forward service/"$APP" 8080:80 \
    >"$port_forward_log" 2>&1 &
  port_forward_pid=$!

  for _ in {1..30}; do
    if curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      kill "$port_forward_pid" >/dev/null 2>&1 || true
      wait "$port_forward_pid" 2>/dev/null || true
      port_forward_pid=
      rm -f "$port_forward_log"
      return 0
    fi
    if ! kill -0 "$port_forward_pid" 2>/dev/null; then
      cat "$port_forward_log" >&2
      port_forward_pid=
      rm -f "$port_forward_log"
      return 1
    fi
    sleep 1
  done

  echo 'Timed out waiting for /healthz through the rendered Service port-forward.' >&2
  cat "$port_forward_log" >&2
  kill "$port_forward_pid" >/dev/null 2>&1 || true
  wait "$port_forward_pid" 2>/dev/null || true
  port_forward_pid=
  rm -f "$port_forward_log"
  return 1
}

assert_application_revision() {
  local stage=$1
  local helm_revision=$2
  local expected_image=$3
  local expected_application_revision=$4
  local actual_image
  local actual_application_revision
  local recorded_application_revision
  local actual_helm_revision

  actual_image=$(kubectl --namespace "$NAMESPACE" get deployment "$APP" \
    --output jsonpath='{.spec.template.spec.containers[0].image}')
  actual_application_revision=$(kubectl --namespace "$NAMESPACE" get deployment "$APP" \
    --output jsonpath='{.spec.template.metadata.annotations.lifecycle-image-revision}')
  recorded_application_revision=$(helm get values "$RELEASE" --namespace "$NAMESPACE" \
    --revision "$helm_revision" --output json |
    jq --exit-status --raw-output '.podAnnotations["lifecycle-image-revision"]')
  actual_helm_revision=$(helm history "$RELEASE" --namespace "$NAMESPACE" --output json |
    jq --exit-status --raw-output 'last | .revision')

  [ "$actual_image" = "$expected_image" ]
  [ "$actual_application_revision" = "$expected_application_revision" ]
  [ "$recorded_application_revision" = "$expected_application_revision" ]
  [ "$actual_helm_revision" = "$helm_revision" ]
  printf 'Helm lifecycle evidence: stage=%s helmRevision=%s image=%s applicationRevision=%s\n' \
    "$stage" "$helm_revision" "$actual_image" "$actual_application_revision"
}


kind load docker-image --name "$KIND_CLUSTER_NAME" "$WIKI_TEST_PREVIOUS_IMAGE"

helm install "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set fullnameOverride="$APP" \
  --set ingress.enabled=false \
  --set image.repository="$PREVIOUS_IMAGE_REPOSITORY" \
  --set-string image.tag="$PREVIOUS_IMAGE_TAG" \
  --set-string image.digest="$PREVIOUS_IMAGE_DIGEST" \
  --set-string podAnnotations.lifecycle-image-revision="$INITIAL_IMAGE_REVISION" \
  --set image.imagePullPolicy=Never \
  --set persistence.size=1Gi \
  --set postgresql.postgresqlPassword='Password123!' \
  --set postgresql.persistence.size=1Gi \
  --set postgresql.image.repository="$POSTGRES_TEST_IMAGE_REPOSITORY" \
  --set-string postgresql.image.tag="$POSTGRES_TEST_IMAGE_TAG" \
  --set postgresql.image.pullPolicy=Never \
  --set startupProbe.initialDelaySeconds=1 \
  --wait \
  --timeout 10m

APPLICATION_CONTAINER=$(kubectl --namespace "$NAMESPACE" get deployment "$APP" \
  --output jsonpath='{.spec.template.spec.containers[0].name}')
assert_application_revision installed 1 "$INITIAL_IMAGE" "$INITIAL_IMAGE_REVISION"
assert_service_port_forward_health

setup_response=$(app_request \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"http://wiki-lifecycle\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  http://127.0.0.1:3000/finalize) || setup_response=
if [ -n "$setup_response" ]; then
  printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
fi

jwt=$(wait_for_login)
create_response=$(app_request \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $jwt" \
  --data '{"content":"# Helm lifecycle","description":"Helm persistence smoke","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"helm-lifecycle","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Helm lifecycle"}' \
  http://127.0.0.1:3000/_api/pages)
page_id=$(printf '%s' "$create_response" | jq --exit-status --raw-output '.page.id')
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

UPGRADE_LOG=$(mktemp)
helm upgrade "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --reuse-values \
  --set image.repository="$WIKI_TEST_IMAGE_REPOSITORY" \
  --set-string image.digest= \
  --set-string image.tag="$WIKI_TEST_IMAGE_TAG" \
  --set-string podAnnotations.lifecycle-stage=upgraded \
  --set-string podAnnotations.lifecycle-image-revision="$CANDIDATE_IMAGE_REVISION" \
  --rollback-on-failure \
  --wait \
  --timeout 10m >"$UPGRADE_LOG" 2>&1 &
upgrade_pid=$!

while kill -0 "$upgrade_pid" 2>/dev/null; do
  if ! assert_no_mixed_application_versions; then
    kill "$upgrade_pid" >/dev/null 2>&1 || true
    wait "$upgrade_pid" 2>/dev/null || true
    cat "$UPGRADE_LOG" >&2
    exit 1
  fi
  sleep 1
done
if ! wait "$upgrade_pid"; then
  cat "$UPGRADE_LOG" >&2
  exit 1
fi
assert_no_mixed_application_versions

[ "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" = upgraded ]
assert_application_revision upgraded 2 "$CANDIDATE_IMAGE" "$CANDIDATE_IMAGE_REVISION"
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm rollback "$RELEASE" 1 --namespace "$NAMESPACE" --wait --timeout 10m
[ -z "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" ]
assert_application_revision rolled-back 3 "$INITIAL_IMAGE" "$INITIAL_IMAGE_REVISION"
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait
kubectl --namespace "$NAMESPACE" get pvc "$APP-data" >/dev/null
kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" >/dev/null

lifecycle_succeeded=true
echo 'Helm install, stateful upgrade, rollback, health test, and retained-PVC lifecycle passed.'
