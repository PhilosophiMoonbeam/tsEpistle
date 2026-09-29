#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_MAJOR:?POSTGRES_MAJOR is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"

dev/e2e/ci-setup.sh
wiki_port=$(docker port "${WIKI_TEST_NAMESPACE}-wiki" 3000/tcp)
wiki_port=${wiki_port##*:}
export PLAYWRIGHT_BASE_URL="http://127.0.0.1:$wiki_port"
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
