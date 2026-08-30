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

rendered_release=$(helm install wiki dev/helm \
  --dry-run=client \
  --namespace wiki-access \
  --set ingress.enabled=false \
  --set "$HELM_PASSWORD_VALUE")
expected_port_forward='kubectl --namespace wiki-access port-forward service/wiki-tsfranki 8080:80'
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
