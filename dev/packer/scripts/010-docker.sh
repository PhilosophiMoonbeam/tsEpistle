#!/bin/bash
set -euo pipefail

: "${application_image:?application_image is required}"
: "${postgres_image:?postgres_image is required}"
: "${docker_package_manifest_sha256:?docker_package_manifest_sha256 is required}"
if [[ ! "$application_image" =~ ^ghcr\.io/philosophimoonbeam/wiki@sha256:[0-9a-f]{64}$ ]]; then
  echo "application_image must be the canonical application repository pinned to a sha256 digest" >&2
  exit 1
fi
if [[ ! "$postgres_image" =~ ^docker\.io/library/postgres@sha256:[0-9a-f]{64}$ ]]; then
  echo "postgres_image must be the canonical PostgreSQL repository pinned to a sha256 digest" >&2
  exit 1
fi
if [[ ! "$docker_package_manifest_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "docker_package_manifest_sha256 must be a sha256 digest" >&2
  exit 1
fi

runtime_inputs=/tmp/runtime-inputs/runtime-inputs.json
package_archive=/tmp/runtime-inputs/docker-packages.tar
package_dir=/tmp/docker-packages
manifest="$package_dir/docker-packages.json"

test -f "$runtime_inputs"
test -f "$package_archive"
rm -rf "$package_dir"
tar -xf "$package_archive" -C /tmp
printf '%s  %s\n' "$docker_package_manifest_sha256" "$manifest" | sha256sum --check --strict
jq -e '
  length == 5
  and ([.[].package] | sort == [
    "containerd.io",
    "docker-buildx-plugin",
    "docker-ce",
    "docker-ce-cli",
    "docker-compose-plugin"
  ])
  and all(.[];
    .architecture == "amd64"
    and (.file | test("^[A-Za-z0-9.+:~_-]+\\.deb$"))
    and (.sha256 | test("^[0-9a-f]{64}$"))
  )
' "$manifest" >/dev/null
while IFS=$'\t' read -r digest filename; do
  printf '%s  %s\n' "$digest" "$package_dir/$filename"
done < <(jq -r '.[] | [.sha256, .file] | @tsv' "$manifest") | sha256sum --check --strict

mapfile -t docker_packages < <(jq -r '.[].file' "$manifest")
for index in "${!docker_packages[@]}"; do
  docker_packages[$index]="$package_dir/${docker_packages[$index]}"
done
sudo apt-get -qqy install "${docker_packages[@]}"

systemctl enable docker
systemctl start docker

# Setup containers

mkdir -p /etc/wiki
sudo install -m 0644 "$runtime_inputs" /etc/wiki/snapshot-provenance-inputs.json

docker network create wikinet
docker volume create pgdata
docker create --name=db -e POSTGRES_DB=wiki -e POSTGRES_USER=wiki -e POSTGRES_PASSWORD_FILE=/etc/wiki/.db-secret -v /etc/wiki/.db-secret:/etc/wiki/.db-secret:ro -v pgdata:/var/lib/postgresql/data --restart=unless-stopped -h db --network=wikinet "$postgres_image"
docker create --name=wiki -e DB_TYPE=postgres -e DB_HOST=db -e DB_PORT=5432 -e DB_PASS_FILE=/etc/wiki/.db-secret -v /etc/wiki/.db-secret:/etc/wiki/.db-secret:ro -e DB_USER=wiki -e DB_NAME=wiki --restart=unless-stopped -h wiki --network=wikinet -p 80:3000 -p 443:3443 "$application_image"
