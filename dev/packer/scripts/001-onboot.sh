#!/bin/bash
set -euo pipefail

secret=/etc/wiki/.db-secret
secret_temp=''
ssh_gate=/etc/ssh/sshd_config.d/90-tsepistle-firstboot.conf
ssh_gate_configuration=$'# Managed by tsEpistle firstboot; do not edit.\nMatch User root\n  ForceCommand echo "Please wait while we get your droplet ready..."\nMatch all\n'

owns_ssh_gate() {
  [[ -f "$ssh_gate" && ! -L "$ssh_gate" && -O "$ssh_gate" ]] &&
    [[ "$(stat -c '%a' "$ssh_gate")" == 600 ]] &&
    [[ "$(cat "$ssh_gate" && printf '.')" == "$ssh_gate_configuration." ]]
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$secret_temp" ]]; then
    rm -f -- "$secret_temp" || cleanup_failed=1
  fi
  if [[ -e "$ssh_gate" || -L "$ssh_gate" ]]; then
    if owns_ssh_gate; then
      if rm -- "$ssh_gate"; then
        systemctl reload ssh || cleanup_failed=1
      else
        cleanup_failed=1
      fi
    else
      echo "Refusing to remove an unrecognized firstboot SSH drop-in" >&2
      cleanup_failed=1
    fi
  fi
  if (( status == 0 && cleanup_failed != 0 )); then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e "$ssh_gate" || -L "$ssh_gate" ]]; then
  if ! owns_ssh_gate; then
    echo "Unrecognized firstboot SSH drop-in; refusing startup" >&2
    exit 1
  fi
fi
if [[ ! -d /etc/wiki || -L /etc/wiki || ! -O /etc/wiki ]] ||
    [[ "$(stat -c '%a' /etc/wiki)" != 700 ]]; then
  echo "Database credential directory is not private and owned by root" >&2
  exit 1
fi
if [[ -L "$secret" || ( -e "$secret" && ( ! -f "$secret" || ! -O "$secret" ) ) ]]; then
  echo "Database credential must be an owned regular file" >&2
  exit 1
fi
if [[ -e "$secret" && "$(stat -c '%a' "$secret")" != 444 ]]; then
  echo "Database credential is not safely readable by its consumers" >&2
  exit 1
fi

valid_secret() {
  local credential=''
  # A NUL terminates read successfully; reject it, embedded lines and whitespace.
  if IFS= read -r -d '' credential < "$1"; then
    return 1
  fi
  credential=${credential%$'\n'}
  [[ "$credential" =~ ^[[:graph:]]+$ ]]
}

if [[ ! -s "$secret" ]]; then
  if [[ -z "${DATABASE_URL:-}" ]]; then
    # Never invent a replacement password for a database that may hold data.
    # "created" is Docker's never-started state, not an exited/restarting DB.
    if [[ "$(docker inspect --format '{{.State.Status}}' db)" != created ]]; then
      echo "Database was already started but its credential is missing or empty" >&2
      exit 1
    fi
  fi
  secret_temp=$(mktemp /etc/wiki/.db-secret.XXXXXX)
  openssl rand -base64 32 > "$secret_temp"
  if [[ "$(stat -c '%s' "$secret_temp")" -lt 32 ]] || ! valid_secret "$secret_temp"; then
    echo "Random credential generation did not produce a usable secret" >&2
    exit 1
  fi
  chown root:root "$secret_temp"
  chmod 0444 "$secret_temp"
  mv -T -- "$secret_temp" "$secret"
  secret_temp=''
elif ! valid_secret "$secret"; then
  echo "Database credential is unusable; refusing to replace it" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  docker start db
  ready=0
  for (( attempt=0; attempt<60; attempt++ )); do
    if docker exec db pg_isready -h 127.0.0.1 -U wiki -d wiki -t 2 >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if (( ready == 0 )); then
    echo "Database did not become ready before the firstboot deadline" >&2
    exit 1
  fi
fi
docker start wiki
