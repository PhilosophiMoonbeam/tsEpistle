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
SITE_ORIGIN=http://wiki-lifecycle
COOKIE_FILE=/tmp/wiki-lifecycle-smoke.cookies
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
RECOVERY_DIR=$(mktemp -d)
chmod 700 "$RECOVERY_DIR"
DATABASE_BACKUP="$RECOVERY_DIR/wiki.dump"
DATA_BACKUP="$RECOVERY_DIR/wiki-data.tar"
HELPER="$APP-recovery"
namespace_owned=false
helper_active=false
PAGE_CONTENT='# Helm lifecycle'

kind export kubeconfig --name "$KIND_CLUSTER_NAME" --kubeconfig "$RECOVERY_DIR/kubeconfig"
export KUBECONFIG="$RECOVERY_DIR/kubeconfig"
[ "$(kubectl config current-context)" = "kind-$KIND_CLUSTER_NAME" ]
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Refusing to adopt existing namespace $NAMESPACE." >&2
  exit 1
fi

cleanup() {
  if [ "$namespace_owned" = true ] && [ "$(kubectl get namespace "$NAMESPACE" --output jsonpath='{.metadata.uid}' 2>/dev/null || true)" = "$namespace_uid" ]; then
    if [ "${lifecycle_succeeded:-false}" != true ]; then
      kubectl --namespace "$NAMESPACE" get all,pvc 2>/dev/null || true
      kubectl --namespace "$NAMESPACE" describe pods 2>/dev/null || true
      kubectl --namespace "$NAMESPACE" logs deployment/"$APP" --all-containers 2>/dev/null || true
    fi
    kubectl --namespace "$NAMESPACE" delete pod "$HELPER" --wait=false >/dev/null 2>&1 || true
    helm uninstall "$RELEASE" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
    kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1 || true
  fi
  if [ -n "${port_forward_pid:-}" ]; then
    kill "$port_forward_pid" >/dev/null 2>&1 || true
    wait "$port_forward_pid" 2>/dev/null || true
  fi
  if [ -n "${UPGRADE_LOG:-}" ]; then
    rm -f "$UPGRADE_LOG"
  fi
  rm -rf "$RECOVERY_DIR"
}
trap cleanup EXIT

app_request() {
  kubectl --namespace "$NAMESPACE" exec deployment/"$APP" -- curl \
    --fail --silent --show-error "$@"
}

legacy_login() {
  local response
  response=$(app_request \
    --header 'Content-Type: application/json' \
    --data "$(jq --null-input --arg username "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{query: "mutation ($username: String!, $password: String!) { authentication { login(username: $username, password: $password, strategy: \"local\") { jwt responseResult { succeeded } } } }", variables: {username: $username, password: $password}}')" \
    http://127.0.0.1:3000/graphql)
  printf '%s' "$response" | jq --exit-status --raw-output \
    '.data.authentication.login | select(.responseResult.succeeded == true) | .jwt | select(type == "string" and length > 0)'
}

current_login() {
  local response
  response=$(app_request \
    --cookie-jar "$COOKIE_FILE" \
    --header "Origin: $SITE_ORIGIN" \
    --header 'Content-Type: application/json' \
    --data "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"strategy\":\"local\"}" \
    http://127.0.0.1:3000/_api/auth/login)
  printf '%s' "$response" | jq --exit-status '.authenticated == true and (has("jwt") | not)' >/dev/null
}

wait_for_login() {
  local login_method=$1
  for _ in {1..90}; do
    if "$login_method" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo 'Timed out waiting for Wiki authentication after setup or rollout.' >&2
  return 1
}

assert_page() {
  local mode=$1
  local token=$2
  local page_id=$3
  local response
  if [ "$mode" = current ]; then
    response=$(app_request --cookie "$COOKIE_FILE" "http://127.0.0.1:3000/_api/pages/$page_id")
    printf '%s' "$response" | jq --exit-status --argjson id "$page_id" \
      '.id == $id and .path == "helm-lifecycle" and .title == "Helm lifecycle"' >/dev/null
    [ "$(database_report wiki | jq --compact-output '.page')" = \
      "$(printf '%s' "$baseline_report" | jq --compact-output '.page')" ]
  else
    response=$(app_request \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $token" \
      --data "$(jq --null-input --argjson id "$page_id" '{query: "query ($id: Int!) { pages { single(id: $id) { id path title content } } }", variables: {id: $id}}')" \
      http://127.0.0.1:3000/graphql)
    printf '%s' "$response" | jq --exit-status --argjson id "$page_id" --arg content "$PAGE_CONTENT" \
      '.data.pages.single | .id == $id and .path == "helm-lifecycle" and .title == "Helm lifecycle" and .content == $content' >/dev/null
  fi
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
  local port_forward_log port_forward_url
  local forwarding_pattern='Forwarding from 127\.0\.0\.1:([0-9]+) -> [0-9]+'
  port_forward_log=$(mktemp)
  kubectl --namespace "$NAMESPACE" port-forward --address 127.0.0.1 service/"$APP" :80 \
    >"$port_forward_log" 2>&1 &
  port_forward_pid=$!

  for _ in {1..30}; do
    if [[ "$(<"$port_forward_log")" =~ $forwarding_pattern ]]; then
      port_forward_url="http://127.0.0.1:${BASH_REMATCH[1]}/healthz"
      if curl --fail --silent --show-error "$port_forward_url" >/dev/null 2>&1; then
        kill "$port_forward_pid" >/dev/null 2>&1 || true
        wait "$port_forward_pid" 2>/dev/null || true
        port_forward_pid=
        rm -f "$port_forward_log"
        return 0
      fi
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

db_exec() {
  kubectl --namespace "$NAMESPACE" exec statefulset/"$APP-postgresql" -- "$@"
}

database_report() {
  local database=$1
  db_exec psql --username=postgres --dbname="$database" --tuples-only --no-align \
    --command="SELECT json_build_object(
      'page', (SELECT json_build_object('id', id, 'path', path, 'title', title, 'content', content)
               FROM pages WHERE path = 'helm-lifecycle'),
      'migrations', (SELECT json_agg(name ORDER BY id) FROM migrations)
    );"
}

assert_database_state() {
  local report
  report=$(database_report wiki)
  [ "$report" = "$baseline_report" ]
  [ "$(db_exec psql --username=postgres --dbname=wiki --tuples-only --no-align \
    --command="SELECT COUNT(*) FROM pages WHERE path = 'helm-candidate-only';" | tr -d '[:space:]')" = 0 ]
}

drain_application() {
  kubectl --namespace "$NAMESPACE" scale deployment "$APP" --replicas=0
  for _ in {1..90}; do
    if kubectl --namespace "$NAMESPACE" get pods -l "$APP_SELECTOR" --output json |
      jq --exit-status '.items | length == 0' >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo 'Application pods remained after writer drain.' >&2
  return 1
}

start_data_helper() {
  local archive_image="$POSTGRES_TEST_IMAGE_REPOSITORY:$POSTGRES_TEST_IMAGE_TAG"
  kubectl --namespace "$NAMESPACE" run "$HELPER" \
    --image="$archive_image" --image-pull-policy=Never --restart=Never \
    --labels=lifecycle-recovery-helper=true \
    --overrides="$(jq --null-input --arg image "$archive_image" --arg claim "$APP-data" \
      '{spec: {containers: [{name: "archive", image: $image, imagePullPolicy: "Never",
        command: ["sh", "-c", "sleep 3600"], securityContext: {runAsUser: 0},
        volumeMounts: [{name: "wiki-data", mountPath: "/wiki/data"}]}],
        volumes: [{name: "wiki-data", persistentVolumeClaim: {claimName: $claim}}]}}')" \
    >/dev/null
  helper_active=true
  kubectl --namespace "$NAMESPACE" wait --for=condition=Ready "pod/$HELPER" --timeout=2m
}

stop_data_helper() {
  if [ "$helper_active" = true ]; then
    kubectl --namespace "$NAMESPACE" delete pod "$HELPER" --wait=true --timeout=2m
    helper_active=false
  fi
}

ready_image_id() {
  kubectl --namespace "$NAMESPACE" get pods -l "$APP_SELECTOR" --output json |
    jq --exit-status --raw-output --arg container "$APPLICATION_CONTAINER" '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
        | .status.containerStatuses[]? | select(.name == $container) | .imageID] |
      if length == 1 and (.[0] | type == "string" and length > 0) then .[0] else error("one Ready application pod required") end'
}

assert_replica_ready() {
  [ "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.replicas}')" = 1 ]
  kubectl --namespace "$NAMESPACE" rollout status deployment/"$APP" --timeout=2m
}

if ! kind_nodes=$(kind get nodes --name "$KIND_CLUSTER_NAME"); then
  echo "Unable to list nodes in kind cluster '$KIND_CLUSTER_NAME'." >&2
  exit 1
fi
if [[ -z "$kind_nodes" ]]; then
  echo "No nodes found in kind cluster '$KIND_CLUSTER_NAME'." >&2
  exit 1
fi

node_count=0
while IFS= read -r node; do
  [[ -n "$node" ]] || continue
  node_count=$((node_count + 1))
  if ! docker exec "$node" ctr --namespace=k8s.io images pull --platform linux/amd64 "$INITIAL_IMAGE" >/dev/null; then
    echo "Unable to pull previous-release image '$INITIAL_IMAGE' into kind node '$node'." >&2
    exit 1
  fi
  printf 'Pinned previous release available on kind node %s\n' "$node"
done <<< "$kind_nodes"

if (( node_count == 0 )); then
  echo "No nodes found in kind cluster '$KIND_CLUSTER_NAME'." >&2
  exit 1
fi

kubectl create namespace "$NAMESPACE"
namespace_uid=$(kubectl get namespace "$NAMESPACE" --output jsonpath='{.metadata.uid}')
namespace_owned=true

helm install "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --set replicaCount=1 \
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
APP_SELECTOR=$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output json |
  jq --exit-status --raw-output '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")')
database_pvc_uid=$(kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" --output jsonpath='{.metadata.uid}')
data_pvc_uid=$(kubectl --namespace "$NAMESPACE" get pvc "$APP-data" --output jsonpath='{.metadata.uid}')
postgres_pod_uid=$(kubectl --namespace "$NAMESPACE" get pod "$APP-postgresql-0" --output jsonpath='{.metadata.uid}')
secret_uid=$(kubectl --namespace "$NAMESPACE" get secret "$APP-postgresql" --output jsonpath='{.metadata.uid}')
printf 'Recovery point identities: databasePVC=%s dataPVC=%s postgresPod=%s secret=%s postgresVersion=%s\n' \
  "$database_pvc_uid" "$data_pvc_uid" "$postgres_pod_uid" "$secret_uid" \
  "$(db_exec psql --username=postgres --dbname=wiki --tuples-only --no-align --command='SHOW server_version;')"
assert_application_revision installed 1 "$INITIAL_IMAGE" "$INITIAL_IMAGE_REVISION"
assert_replica_ready
initial_runtime_image=$(ready_image_id)
assert_service_port_forward_health

setup_response=$(app_request \
  --header 'Content-Type: application/json' \
  --data "{\"siteUrl\":\"http://wiki-lifecycle\",\"adminEmail\":\"$ADMIN_EMAIL\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"telemetry\":false}" \
  http://127.0.0.1:3000/finalize) || setup_response=
if [ -n "$setup_response" ]; then
  printf '%s' "$setup_response" | jq --exit-status '.ok == true' >/dev/null
fi

jwt=$(wait_for_login legacy_login)
create_response=$(app_request \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $jwt" \
  --data "$(jq --null-input --arg query 'mutation { pages { create(content: "# Helm lifecycle", description: "Helm persistence smoke", editor: "markdown", isPublished: true, isPrivate: false, locale: "en", path: "helm-lifecycle", tags: [], title: "Helm lifecycle") { responseResult { succeeded message } page { id } } } }' '{query: $query}')" \
  http://127.0.0.1:3000/graphql)
if ! page_id=$(printf '%s' "$create_response" | jq --exit-status --raw-output \
  '.data.pages.create | select(.responseResult.succeeded == true) | .page.id | select(type == "number")'); then
  printf 'Could not create legacy Helm lifecycle page: %s\n' "$create_response" >&2
  exit 1
fi
assert_page legacy "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m
kubectl --namespace "$NAMESPACE" exec deployment/"$APP" -- sh -c \
  'printf "%s" "pre-upgrade fixture" > /wiki/data/.helm-lifecycle-fixture && chmod 640 /wiki/data/.helm-lifecycle-fixture'
drain_application
baseline_report=$(database_report wiki)
printf '%s' "$baseline_report" | jq --exit-status --argjson id "$page_id" --arg content "$PAGE_CONTENT" \
  '.page.id == $id and .page.path == "helm-lifecycle" and .page.title == "Helm lifecycle" and .page.content == $content and (.migrations | length > 0)' >/dev/null
db_exec pg_dump --username=postgres --dbname=wiki --format=custom >"$DATABASE_BACKUP"
db_exec createdb --username=postgres --owner=postgres --template=template0 wiki_restore_check
kubectl --namespace "$NAMESPACE" exec -i statefulset/"$APP-postgresql" -- \
  pg_restore --username=postgres --dbname=wiki_restore_check --exit-on-error --single-transaction <"$DATABASE_BACKUP"
[ "$(database_report wiki_restore_check)" = "$baseline_report" ]
db_exec dropdb --username=postgres wiki_restore_check
start_data_helper
kubectl --namespace "$NAMESPACE" exec "$HELPER" -- tar -C /wiki/data -cf - . >"$DATA_BACKUP"
tar -tf "$DATA_BACKUP" >/dev/null
fixture_before=$(kubectl --namespace "$NAMESPACE" exec "$HELPER" -- sh -c \
  'sha256sum /wiki/data/.helm-lifecycle-fixture; stat -c "%u:%g:%a" /wiki/data/.helm-lifecycle-fixture')
stop_data_helper
database_sha=$(sha256sum "$DATABASE_BACKUP" | cut -d ' ' -f1)
data_sha=$(sha256sum "$DATA_BACKUP" | cut -d ' ' -f1)
printf 'Verified paired recovery point: databaseSHA256=%s dataSHA256=%s\n' "$database_sha" "$data_sha"

UPGRADE_LOG=$(mktemp)
helm upgrade "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --reuse-values \
  --set image.repository="$WIKI_TEST_IMAGE_REPOSITORY" \
  --set-string image.digest= \
  --set-string image.tag="$WIKI_TEST_IMAGE_TAG" \
  --set-string podAnnotations.lifecycle-stage=upgraded \
  --set-string podAnnotations.lifecycle-image-revision="$CANDIDATE_IMAGE_REVISION" \
  --force-conflicts \
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
assert_replica_ready
candidate_runtime_image=$(ready_image_id)
[ "$candidate_runtime_image" != "$initial_runtime_image" ]
wait_for_login current_login
assert_page current '' "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m
candidate_response=$(app_request \
  --cookie "$COOKIE_FILE" \
  --header "Origin: $SITE_ORIGIN" \
  --header 'Content-Type: application/json' \
  --data '{"content":"# Discard after rollback","description":"recovery sentinel","editor":"markdown","visibility":"public","isPublished":true,"locale":"en","path":"helm-candidate-only","publishEndDate":"","publishStartDate":"","scriptCss":"","scriptJs":"","tags":[],"title":"Candidate only"}' \
  http://127.0.0.1:3000/_api/pages)
printf '%s' "$candidate_response" | jq --exit-status '.page.id | type == "number"' >/dev/null
kubectl --namespace "$NAMESPACE" exec deployment/"$APP" -- sh -c \
  'printf "%s" "modified by candidate" > /wiki/data/.helm-lifecycle-fixture; printf "%s" "discard me" > /wiki/data/.helm-candidate-only'
[ "$(db_exec psql --username=postgres --dbname=wiki --tuples-only --no-align \
  --command="SELECT COUNT(*) FROM pages WHERE path = 'helm-candidate-only';" | tr -d '[:space:]')" = 1 ]
drain_application
printf '%s  %s\n' "$database_sha" "$DATABASE_BACKUP" | sha256sum --check --status
printf '%s  %s\n' "$data_sha" "$DATA_BACKUP" | sha256sum --check --status
db_exec dropdb --username=postgres --force wiki
db_exec createdb --username=postgres --owner=postgres --template=template0 wiki
kubectl --namespace "$NAMESPACE" exec -i statefulset/"$APP-postgresql" -- \
  pg_restore --username=postgres --dbname=wiki --exit-on-error --single-transaction <"$DATABASE_BACKUP"
assert_database_state
start_data_helper
kubectl --namespace "$NAMESPACE" exec "$HELPER" -- sh -c \
  'for entry in /wiki/data/* /wiki/data/.[!.]* /wiki/data/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then rm -rf -- "$entry" || exit 1; fi
  done'
kubectl --namespace "$NAMESPACE" exec -i "$HELPER" -- tar --numeric-owner -C /wiki/data -xf - <"$DATA_BACKUP"
[ "$(kubectl --namespace "$NAMESPACE" exec "$HELPER" -- sh -c \
  'sha256sum /wiki/data/.helm-lifecycle-fixture; stat -c "%u:%g:%a" /wiki/data/.helm-lifecycle-fixture')" = "$fixture_before" ]
kubectl --namespace "$NAMESPACE" exec "$HELPER" -- test ! -e /wiki/data/.helm-candidate-only
stop_data_helper
[ "$(kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" --output jsonpath='{.metadata.uid}')" = "$database_pvc_uid" ]
[ "$(kubectl --namespace "$NAMESPACE" get pvc "$APP-data" --output jsonpath='{.metadata.uid}')" = "$data_pvc_uid" ]
[ "$(kubectl --namespace "$NAMESPACE" get pod "$APP-postgresql-0" --output jsonpath='{.metadata.uid}')" = "$postgres_pod_uid" ]
[ "$(kubectl --namespace "$NAMESPACE" get secret "$APP-postgresql" --output jsonpath='{.metadata.uid}')" = "$secret_uid" ]

helm rollback "$RELEASE" 1 --namespace "$NAMESPACE" --force-conflicts --wait --timeout 10m
[ -z "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" ]
assert_application_revision rolled-back 3 "$INITIAL_IMAGE" "$INITIAL_IMAGE_REVISION"
assert_replica_ready
rolled_back_runtime_image=$(ready_image_id)
[ "$rolled_back_runtime_image" = "$initial_runtime_image" ]
[ "$rolled_back_runtime_image" != "$candidate_runtime_image" ]
printf 'Ready application imageIDs: installed=%s upgraded=%s rolledBack=%s\n' \
  "$initial_runtime_image" "$candidate_runtime_image" "$rolled_back_runtime_image"
jwt=$(wait_for_login legacy_login)
assert_page legacy "$jwt" "$page_id"
assert_service_port_forward_health
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait
kubectl --namespace "$NAMESPACE" get pvc "$APP-data" >/dev/null
kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" >/dev/null
[ "$(kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" --output jsonpath='{.metadata.uid}')" = "$database_pvc_uid" ]
[ "$(kubectl --namespace "$NAMESPACE" get pvc "$APP-data" --output jsonpath='{.metadata.uid}')" = "$data_pvc_uid" ]

lifecycle_succeeded=true
echo 'Helm install, stateful upgrade, rollback, health test, and retained-PVC lifecycle passed.'
