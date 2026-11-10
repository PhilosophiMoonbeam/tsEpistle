#!/bin/bash

# DigitalOcean Marketplace Image Validation Tool
# © 2021 DigitalOcean LLC.
# This code is licensed under Apache 2.0 license (see LICENSE.md for details)

set -o errexit

# Ensure /tmp exists and has the proper permissions before
# checking for security updates
# https://github.com/digitalocean/marketplace-partners/issues/94
if [[ ! -d /tmp ]]; then
  mkdir /tmp
fi
chmod 1777 /tmp

export DEBIAN_FRONTEND=noninteractive
apt-get -y update
apt-get -y purge droplet-agent
rm -rf /opt/digitalocean
apt-get -y autoremove
apt-get -y autoclean

rm -rf /tmp/* /var/tmp/*
history -c
cat /dev/null > /root/.bash_history
unset HISTFILE
find /var/log -mtime -1 -type f -exec truncate -s 0 {} \;
rm -rf /var/log/*.gz /var/log/*.[0-9] /var/log/*-????????
rm -rf /var/lib/cloud/instances/*
rm -f /root/.ssh/authorized_keys /etc/ssh/*key*
touch /etc/ssh/revoked_keys
chmod 600 /etc/ssh/revoked_keys

# Zero-fill free space in this disposable image build. This is not a guarantee
# of physical secure erasure on the underlying storage.
fill_file=''
diagnostic_file=''
dd_pid=''

cleanup_zero_fill() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$dd_pid" ]]; then
    # Stop and reap the writer before unlinking its output, including on signals.
    kill -TERM "$dd_pid" 2>/dev/null || :
    wait "$dd_pid" 2>/dev/null || :
  fi
  if [[ -n "$fill_file" ]]; then
    if rm -f -- "$fill_file"; then
      :
    else
      [[ "$status" -ne 0 ]] || status=1
    fi
  fi
  if [[ -n "$diagnostic_file" ]]; then
    if rm -f -- "$diagnostic_file"; then
      :
    else
      [[ "$status" -ne 0 ]] || status=1
    fi
  fi
  exit "$status"
}

trap cleanup_zero_fill EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

diagnostic_file=$(mktemp /run/tsepistle-zero-fill.XXXXXX)
fill_file=$(mktemp /tsepistle-zero-fill.XXXXXX)
printf '\nZero-filling unused image filesystem space.\n'
LC_ALL=C dd if=/dev/zero of="$fill_file" bs=4096 2>"$diagnostic_file" &
dd_pid=$!
dd_status=0
wait "$dd_pid" || dd_status=$?
dd_pid=''

# An unbounded fill must fail specifically because the filesystem is full.
# Do not accept text on stdout, another error, or even an unexpected exit 0.
if [[ "$dd_status" -eq 1 ]] &&
  LC_ALL=C grep -qE '^dd: .*writing .*: No space left on device$' "$diagnostic_file"; then
  printf 'Image filesystem zero-fill completed.\n'
else
  cat "$diagnostic_file" >&2
  printf 'Image filesystem zero-fill failed (dd status %s).\n' "$dd_status" >&2
  if [[ "$dd_status" -eq 0 ]]; then
    exit 1
  fi
  exit "$dd_status"
fi
