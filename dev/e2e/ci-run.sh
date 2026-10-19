#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_MAJOR:?POSTGRES_MAJOR is required}"
: "${WIKI_TEST_NAMESPACE:?WIKI_TEST_NAMESPACE is required}"
: "${WIKI_E2E_SUITE:?WIKI_E2E_SUITE is required (core, chromium, firefox, or webkit)}"

case "$WIKI_E2E_SUITE" in
  core)
    suite_args=(
      --project=chromium
      --project=accessibility-keyboard
      --project=accessibility-dark
      --project=accessibility-mobile
      --project=accessibility-tablet
      --project=accessibility-wide
      --project=performance-desktop
      --project=performance-webgpu
      --project=performance-webgl2
      --project=performance-webgl2-swiftshader
    )
    ;;
  chromium)
    suite_args=(
      --project=responsive-chromium-desktop
      --project=responsive-chromium-wide
      --project=responsive-chromium-tablet
      --project=responsive-chromium-mobile
    )
    ;;
  firefox)
    suite_args=(--project=responsive-firefox-desktop)
    ;;
  webkit)
    suite_args=(
      --project=responsive-webkit-desktop
      --project=responsive-webkit-mobile
      --project=responsive-webkit-mobile-landscape
    )
    ;;
  *)
    echo 'WIKI_E2E_SUITE must be core, chromium, firefox, or webkit.' >&2
    exit 1
    ;;
esac

dev/e2e/ci-setup.sh
wiki_port=$(docker port "${WIKI_TEST_NAMESPACE}-wiki" 3000/tcp)
wiki_port=${wiki_port##*:}
export PLAYWRIGHT_BASE_URL="http://127.0.0.1:$wiki_port"
bun run e2e "${suite_args[@]}" "$@"
