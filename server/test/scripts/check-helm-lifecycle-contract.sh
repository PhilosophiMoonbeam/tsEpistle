#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$ROOT"

HELM_PASSWORD_VALUE='postgresql.postgresqlPassword=contract-test-only'

if helm template wiki dev/helm >/dev/null 2>&1; then
  echo 'Chart unexpectedly rendered with the empty default database password.' >&2
  exit 1
fi
helm template wiki dev/helm \
  --set postgresql.existingSecret=wiki-postgresql \
  >/dev/null

helm lint dev/helm --set "$HELM_PASSWORD_VALUE"

rendered_deployment=$(helm template wiki dev/helm \
  --set "$HELM_PASSWORD_VALUE" \
  --show-only templates/deployment.yaml)
if [[ "$rendered_deployment" != *$'strategy:\n    type: Recreate'* ]]; then
  echo 'Rendered Deployment must use the Recreate strategy.' >&2
  exit 1
fi

assert_rendered_contains() {
  local description=$1
  local rendered=$2
  local expected=$3
  if [[ "$rendered" != *"$expected"* ]]; then
    echo "Rendered chart is missing ${description}: ${expected}" >&2
    exit 1
  fi
}

rendered_fresh=$(helm template wiki dev/helm \
  --set "$HELM_PASSWORD_VALUE")
assert_rendered_contains 'fresh Deployment name' "$rendered_fresh" $'kind: Deployment\nmetadata:\n  name: wiki-tsepistle'
assert_rendered_contains 'fresh Service name' "$rendered_fresh" $'kind: Service\nmetadata:\n  name: wiki-tsepistle'
assert_rendered_contains 'fresh application data PVC name' "$rendered_fresh" $'kind: PersistentVolumeClaim\nmetadata:\n  name: wiki-tsepistle-data'
assert_rendered_contains 'fresh PostgreSQL StatefulSet name' "$rendered_fresh" $'kind: StatefulSet\nmetadata:\n  name: wiki-tsepistle-postgresql'
assert_rendered_contains 'fresh PostgreSQL Service name' "$rendered_fresh" $'kind: Service\nmetadata:\n  name: wiki-tsepistle-postgresql'
assert_rendered_contains 'fresh PostgreSQL PVC name' "$rendered_fresh" $'kind: PersistentVolumeClaim\nmetadata:\n  name: wiki-tsepistle-postgresql'
assert_rendered_contains 'fresh PostgreSQL Secret name' "$rendered_fresh" $'kind: Secret\nmetadata:\n  name: wiki-tsepistle-postgresql'
assert_rendered_contains 'fresh service account name' "$rendered_fresh" $'kind: ServiceAccount\nmetadata:\n  name: wiki-tsepistle'
assert_rendered_contains 'fresh Deployment service account reference' "$rendered_fresh" 'serviceAccountName: wiki-tsepistle'

# Compatibility-only render: existing releases must retain their historical identity.

rendered_compatibility=$(helm template wiki dev/helm \
  --set "$HELM_PASSWORD_VALUE" \
  --set nameOverride=tsfranki)
assert_rendered_contains 'historical Deployment name' "$rendered_compatibility" $'kind: Deployment\nmetadata:\n  name: wiki-tsfranki'
assert_rendered_contains 'historical Service name' "$rendered_compatibility" $'kind: Service\nmetadata:\n  name: wiki-tsfranki'
assert_rendered_contains 'historical application data PVC name' "$rendered_compatibility" $'kind: PersistentVolumeClaim\nmetadata:\n  name: wiki-tsfranki-data'
assert_rendered_contains 'historical PostgreSQL StatefulSet name' "$rendered_compatibility" $'kind: StatefulSet\nmetadata:\n  name: wiki-tsfranki-postgresql'
assert_rendered_contains 'historical PostgreSQL Service name' "$rendered_compatibility" $'kind: Service\nmetadata:\n  name: wiki-tsfranki-postgresql'
assert_rendered_contains 'historical PostgreSQL PVC name' "$rendered_compatibility" $'kind: PersistentVolumeClaim\nmetadata:\n  name: wiki-tsfranki-postgresql'
assert_rendered_contains 'historical PostgreSQL Secret name' "$rendered_compatibility" $'kind: Secret\nmetadata:\n  name: wiki-tsfranki-postgresql'
assert_rendered_contains 'historical service account name' "$rendered_compatibility" $'kind: ServiceAccount\nmetadata:\n  name: wiki-tsfranki'
assert_rendered_contains 'historical Deployment service account reference' "$rendered_compatibility" 'serviceAccountName: wiki-tsfranki'
assert_rendered_contains 'historical application selector' "$rendered_compatibility" $'matchLabels:\n      app.kubernetes.io/name: tsfranki\n      app.kubernetes.io/instance: wiki'
assert_rendered_contains 'historical PostgreSQL selector' "$rendered_compatibility" $'matchLabels:\n      app.kubernetes.io/name: tsfranki-postgresql\n      app.kubernetes.io/instance: wiki'
assert_rendered_contains 'historical application Service selector' "$rendered_compatibility" $'selector:\n    app.kubernetes.io/name: tsfranki\n    app.kubernetes.io/instance: wiki'
assert_rendered_contains 'historical PostgreSQL Service selector' "$rendered_compatibility" $'selector:\n    app.kubernetes.io/name: tsfranki-postgresql\n    app.kubernetes.io/instance: wiki'
assert_rendered_contains 'historical application data claim reference' "$rendered_compatibility" $'persistentVolumeClaim:\n            claimName: wiki-tsfranki-data'
assert_rendered_contains 'historical PostgreSQL claim reference' "$rendered_compatibility" $'persistentVolumeClaim:\n            claimName: wiki-tsfranki-postgresql'

rendered_release=$(helm install wiki dev/helm \
  --dry-run=client \
  --namespace wiki-access \
  --set ingress.enabled=false \
  --set "$HELM_PASSWORD_VALUE")
expected_port_forward='kubectl --namespace wiki-access port-forward service/wiki-tsepistle 8080:80'
rendered_port_forward=
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  if [[ "$line" == kubectl\ --namespace\ wiki-access\ port-forward* ]]; then
    rendered_port_forward=$line
  fi
done <<< "$rendered_release"

if [[ "$rendered_port_forward" != "$expected_port_forward" ]]; then
  echo "Expected executable port-forward command: $expected_port_forward" >&2
  echo "Rendered port-forward command: ${rendered_port_forward:-<missing>}" >&2
  exit 1
fi
if [[ "$rendered_release" != *'http://127.0.0.1:8080/healthz'* ]]; then
  echo 'Rendered release notes must identify /healthz through the Service port-forward.' >&2
  exit 1
fi
