#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_MAJOR:?POSTGRES_MAJOR is required}"

dev/e2e/ci-setup.sh
bun --bun playwright test \
  --project=chromium \
  --project=accessibility-keyboard \
  --project=accessibility-dark \
  --project=accessibility-mobile \
  --project=accessibility-tablet \
  --project=accessibility-wide \
  --project=performance-desktop

if [ "$POSTGRES_MAJOR" = '18' ]; then
  bun run e2e:responsive --no-deps
fi
