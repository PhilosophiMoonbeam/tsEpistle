#!/bin/bash
set -euo pipefail

ssh_gate=/etc/ssh/sshd_config.d/90-tsepistle-firstboot.conf
ssh_gate_configuration=$'# Managed by tsEpistle firstboot; do not edit.\nMatch User root\n  ForceCommand echo "Please wait while we get your droplet ready..."\nMatch all\n'
ssh_gate_temp=''
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$ssh_gate_temp" ]]; then
    if ! rm -f -- "$ssh_gate_temp" && (( status == 0 )); then
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -L /etc/ssh/sshd_config.d ]]; then
  echo "Refusing a symlinked SSH drop-in directory" >&2
  exit 1
fi
mkdir -p /etc/ssh/sshd_config.d
if [[ -e "$ssh_gate" || -L "$ssh_gate" ]]; then
  if [[ -f "$ssh_gate" && ! -L "$ssh_gate" && -O "$ssh_gate" ]] &&
      [[ "$(stat -c '%a' "$ssh_gate")" == 600 ]] &&
      [[ "$(cat "$ssh_gate" && printf '.')" == "$ssh_gate_configuration." ]]; then
    exit 0
  fi
  echo "Refusing to replace an unrecognized firstboot SSH drop-in" >&2
  exit 1
fi
ssh_gate_temp=$(mktemp /etc/ssh/sshd_config.d/.90-tsepistle-firstboot.XXXXXX)
printf '%s' "$ssh_gate_configuration" > "$ssh_gate_temp"
chown root:root "$ssh_gate_temp"
chmod 0600 "$ssh_gate_temp"
mv -T -- "$ssh_gate_temp" "$ssh_gate"
ssh_gate_temp=''
