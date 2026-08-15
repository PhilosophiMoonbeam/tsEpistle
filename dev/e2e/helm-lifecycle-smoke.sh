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

cleanup() {
  if [ "${lifecycle_succeeded:-false}" != true ]; then
    kubectl --namespace "$NAMESPACE" get all,pvc 2>/dev/null || true
    kubectl --namespace "$NAMESPACE" describe pods 2>/dev/null || true
    kubectl --namespace "$NAMESPACE" logs deployment/"$APP" --all-containers 2>/dev/null || true
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

helm install "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set fullnameOverride="$APP" \
  --set ingress.enabled=false \
  --set image.repository="$WIKI_TEST_IMAGE_REPOSITORY" \
  --set-string image.tag="$WIKI_TEST_IMAGE_TAG" \
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

helm upgrade "$RELEASE" dev/helm \
  --namespace "$NAMESPACE" \
  --reuse-values \
  --set-string podAnnotations.lifecycle-stage=upgraded \
  --rollback-on-failure \
  --wait \
  --timeout 10m

[ "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" = upgraded ]
[ "$(helm history "$RELEASE" --namespace "$NAMESPACE" --output json | jq --raw-output 'last | .revision')" = 2 ]
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm rollback "$RELEASE" 1 --namespace "$NAMESPACE" --wait --timeout 10m
[ -z "$(kubectl --namespace "$NAMESPACE" get deployment "$APP" --output jsonpath='{.spec.template.metadata.annotations.lifecycle-stage}')" ]
[ "$(helm history "$RELEASE" --namespace "$NAMESPACE" --output json | jq --raw-output 'last | .revision')" = 3 ]
jwt=$(wait_for_login)
assert_page "$jwt" "$page_id"
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m

helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait
kubectl --namespace "$NAMESPACE" get pvc "$APP-data" >/dev/null
kubectl --namespace "$NAMESPACE" get pvc "$APP-postgresql" >/dev/null

lifecycle_succeeded=true
echo 'Helm install, stateful upgrade, rollback, health test, and retained-PVC lifecycle passed.'
