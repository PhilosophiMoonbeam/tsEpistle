#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_MAJOR:?POSTGRES_MAJOR is required}"

run_suite() {
  dev/e2e/ci-setup.sh || return
  bun --bun playwright test \
    --project=chromium \
    --project=accessibility-keyboard \
    --project=accessibility-dark \
    --project=accessibility-mobile \
    --project=accessibility-tablet \
    --project=accessibility-wide \
    --project=performance-desktop || return
  if [ "$POSTGRES_MAJOR" = '18' ]; then
    bun run e2e:responsive --no-deps || return
  fi
}

for attempt in 1 2; do
  if run_suite; then
    exit 0
  fi
  if [ "$attempt" -eq 2 ]; then
    exit 1
  fi
  echo '::warning::The browser suite encountered a transient local-runner failure; rebuilding its isolated services and retrying once.'
  sleep 2
done
