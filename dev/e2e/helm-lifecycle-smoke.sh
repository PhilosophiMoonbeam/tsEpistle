#!/usr/bin/env bash
set -euo pipefail

: "${WIKI_TEST_IMAGE_REPOSITORY:?WIKI_TEST_IMAGE_REPOSITORY is required}"
: "${WIKI_TEST_IMAGE_TAG:?WIKI_TEST_IMAGE_TAG is required}"
: "${POSTGRES_TEST_IMAGE_REPOSITORY:?POSTGRES_TEST_IMAGE_REPOSITORY is required}"
: "${POSTGRES_TEST_IMAGE_TAG:?POSTGRES_TEST_IMAGE_TAG is required}"

RELEASE=wiki
NAMESPACE=wiki-lifecycle
APP=wiki-lifecycle
ADMIN_EMAIL=helm-lifecycle@example.com
ADMIN_PASSWORD=HelmLifecycle123!
INITIAL_IMAGE_TAG="${WIKI_TEST_IMAGE_TAG}-helm-initial"
INITIAL_IMAGE="$WIKI_TEST_IMAGE_REPOSITORY:$INITIAL_IMAGE_TAG"
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
  docker image rm "$INITIAL_IMAGE" >/dev/null 2>&1 || true
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

docker image tag "$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG" "$INITIAL_IMAGE"
kind load docker-image --name "$KIND_CLUSTER_NAME" "$INITIAL_IMAGE"

helm install "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set fullnameOverride="$APP" \
  --set ingress.enabled=false \
  --set image.repository="$WIKI_TEST_IMAGE_REPOSITORY" \
  --set-string image.tag="$INITIAL_IMAGE_TAG" \
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
  --set-string image.tag="$WIKI_TEST_IMAGE_TAG" \
  --set-string podAnnotations.lifecycle-stage=upgraded \
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
[ "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.spec.containers[0].image}')" = "$WIKI_TEST_IMAGE_REPOSITORY:$WIKI_TEST_IMAGE_TAG" ]
[ "$(helm history "$RELEASE" --namespace "$NAMESPACE" --output json | jq --raw-output 'last | .revision')" = 2 ]
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm rollback "$RELEASE" 1 --namespace "$NAMESPACE" --wait --timeout 10m
[ -z "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" ]
[ "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.spec.containers[0].image}')" = "$INITIAL_IMAGE" ]
[ "$(helm history "$RELEASE" --namespace "$NAMESPACE" --output json | jq --raw-output 'last | .revision')" = 3 ]
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait
kubectl --namespace "$NAMESPACE" get pvc "$APP-data" >/dev/null
kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" >/dev/null

lifecycle_succeeded=true
echo 'Helm install, stateful upgrade, rollback, health test, and retained-PVC lifecycle passed.'
