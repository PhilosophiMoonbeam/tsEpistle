#!/usr/bin/env bash
set -euo pipefail
umask 077

root=$(git rev-parse --show-toplevel)
state="${XDG_STATE_HOME:-$HOME/.local/state}/tsepistle-ci"
mkdir -p "$state"
if ! command -v flock >/dev/null; then
  echo 'Local CI requires util-linux flock to keep performance runs exclusive.' >&2
  exit 1
fi
exec flock --nonblock --conflict-exit-code 75 "$state/ci.lock" bun "$root/server/scripts/run-local-ci.ts" "$@"
