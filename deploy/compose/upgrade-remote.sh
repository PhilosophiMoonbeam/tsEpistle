#!/usr/bin/env bash
# Run from the off-box operator checkout; all deployment decisions stay in upgrade.sh.
set -Eeuo pipefail
IFS=$'\n\t'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
HOST=""; REMOTE_REPO=""; PROFILE=""; REVISION=""; IMAGE=""
die() { printf '[upgrade-remote] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage:
  deploy/compose/upgrade-remote.sh --host SSH_HOST --repository /REMOTE/REPO --profile /REMOTE/PROFILE --revision APP_SHA --image REPOSITORY@sha256:DIGEST

Requires verified SSH host keys, noninteractive SSH and sudo, existing remote
root registry authentication, a clean matching operator checkout on both hosts,
and off-box Bun plus the repository's installed pinned @playwright/test and Chromium.
No dependencies, browsers, source or images are built by this command.
EOF
}
while (( $# > 0 )); do
  case "$1" in
    --host|--repository|--profile|--revision|--image)
      (( $# >= 2 )) && [[ -n "$2" ]] || die "$1 requires a value"
      case "$1" in
        --host) HOST="$2" ;; --repository) REMOTE_REPO="$2" ;; --profile) PROFILE="$2" ;;
        --revision) REVISION="$2" ;; --image) IMAGE="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ -n "$HOST" && -n "$REMOTE_REPO" && -n "$PROFILE" && -n "$REVISION" && -n "$IMAGE" ]] || die 'Requires --host, --repository, --profile, --revision and --image'
[[ "$HOST" != -* && "$HOST" != *[[:space:]]* ]] || die 'Invalid SSH destination'
[[ "$REMOTE_REPO" == /* && "$PROFILE" == /* ]] || die 'Remote repository/profile paths must be absolute'
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || die '--revision must be a full lowercase 40-character commit SHA'
[[ "$IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ && "$IMAGE" != -* ]] || die '--image must be an immutable repository@sha256 digest reference'
for command in ssh git jq bun; do command -v "$command" >/dev/null 2>&1 || die "Required off-box command is missing: $command"; done
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- || die 'Off-box checkout has unstaged changes'
git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules -- || die 'Off-box checkout has staged changes'
[[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]] || die 'Off-box checkout has untracked files'
OPERATOR_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
# Use only the repository's direct, exactly pinned dependency. Never install or
# download a dependency/browser as an implicit deployment fallback.
(cd "$REPO_ROOT" && bun --no-env-file - <<'JS'
const fs = require('node:fs')
const expected = require('./package.json').devDependencies['@playwright/test']
const actual = require('@playwright/test/package.json').version
if (!/^\d+\.\d+\.\d+$/.test(expected) || actual !== expected) throw new Error('Install the repository-pinned @playwright/test off-box before deployment')
fs.accessSync(require('@playwright/test').chromium.executablePath(), fs.constants.X_OK)
JS
)
# OpenSSH concatenates command arguments before handing them to the remote
# login shell. POSIX single quoting (not Bash-only %q) preserves every argument.
remote() {
  local argument quoted command_line=""
  for argument in "$@"; do
    quoted="'${argument//\'/\'\\\'\'}'"
    command_line+="${command_line:+ }$quoted"
  done
  ssh -n -T -a -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -- "$HOST" "$command_line"
}
# Uses only the pre-existing remote root Docker credential store; no credentials
# are read, printed, copied, or put on SSH's command line.
remote sudo -n docker image pull -- "$IMAGE" >&2
PLAN_JSON="$(remote sudo -n /bin/bash "$REMOTE_REPO/deploy/compose/upgrade.sh" plan --profile "$PROFILE" --revision "$REVISION" --image "$IMAGE" --json)"
jq -e --arg revision "$REVISION" --arg image "$IMAGE" --arg operator "$OPERATOR_REVISION" '
  .schemaVersion == 1 and .operatorRevision == $operator and .targetRevision == $revision and .candidateImage == $image and
  (.plan | type == "string" and startswith("/") and (test("[\u0000-\u001f]") | not)) and
  (.confirm | test("^[0-9a-f]{64}$")) and (.candidateImageId | test("^sha256:[0-9a-f]{64}$")) and
  (.publicUrl | type == "string" and startswith("https://"))
' <<< "$PLAN_JSON" >/dev/null || die 'Remote plan output or operator checkout binding is invalid'
PLAN="$(jq -r '.plan' <<< "$PLAN_JSON")"; CONFIRM="$(jq -r '.confirm' <<< "$PLAN_JSON")"
PUBLIC_URL="$(jq -r '.publicUrl' <<< "$PLAN_JSON")"
printf '%s\n' "$PLAN_JSON"
remote sudo -n /bin/bash "$REMOTE_REPO/deploy/compose/upgrade.sh" apply --plan "$PLAN" --confirm "$CONFIRM"
if ! TSEPISTLE_SMOKE_URL="$PUBLIC_URL" bun --no-env-file "$SCRIPT_DIR/login-smoke.cjs"; then
  die "Browser verification failed; candidate remains unaccepted. Plan: $PLAN"
fi
remote sudo -n /bin/bash "$REMOTE_REPO/deploy/compose/upgrade.sh" accept --plan "$PLAN" --confirm "$CONFIRM" --browser-smoke-passed
