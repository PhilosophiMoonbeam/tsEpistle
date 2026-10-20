#!/usr/bin/env bash
set -euo pipefail
umask 077

root=$(git rev-parse --show-toplevel)
for argument in "$@"; do
  if [[ "$argument" == --help ]]; then
    exec bun --no-env-file "$root/server/scripts/run-local-ci.ts" --help
  fi
done
state="${XDG_STATE_HOME:-$HOME/.local/state}/tsepistle-ci"
mkdir -p "$state"
for tool in flock systemd-run; do
  if ! command -v "$tool" >/dev/null; then
    echo "Local CI requires $tool for exclusive, memory-bounded execution." >&2
    exit 1
  fi
done
exec systemd-run --user --scope --quiet --collect --unit="tsepistle-ci-launcher-${BASHPID}" \
  --property=MemoryMax=512M --property=MemorySwapMax=0 --property=CPUWeight=10 \
  flock --nonblock --no-fork --conflict-exit-code 75 "$state/ci.lock" \
  bun --no-env-file "$root/server/scripts/run-local-ci.ts" "$@"
