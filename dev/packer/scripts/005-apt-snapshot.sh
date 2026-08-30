#!/bin/bash
set -euo pipefail

: "${apt_snapshot:?apt_snapshot is required}"
if [[ ! "$apt_snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "apt_snapshot must be an Ubuntu snapshot timestamp in YYYYMMDDTHHMMSSZ format" >&2
  exit 1
fi

sudo rm -f /etc/apt/sources.list
sudo rm -rf /etc/apt/sources.list.d
sudo install -m 0755 -d /etc/apt/sources.list.d
sudo tee /etc/apt/sources.list.d/ubuntu.sources >/dev/null <<EOF
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/${apt_snapshot}/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF


sudo apt-get -qq update
sudo apt-get -qqy \
  -o Dpkg::Options::='--force-confdef' \
  -o Dpkg::Options::='--force-confold' \
  full-upgrade
sudo apt-get -qqy \
  -o Dpkg::Options::='--force-confdef' \
  -o Dpkg::Options::='--force-confold' \
  install jq software-properties-common
