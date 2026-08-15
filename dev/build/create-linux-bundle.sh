#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: create-linux-bundle.sh IMAGE OUTPUT}
output=${2:?Usage: create-linux-bundle.sh IMAGE OUTPUT}
: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH is required}"

work_dir=$(mktemp -d)
container_id=
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

container_id=$(docker create "$image")
docker cp "$container_id:/wiki" "$work_dir"
docker rm "$container_id" >/dev/null
container_id=
rm -f "$work_dir/wiki/config.yml"
cp config.sample.yml "$work_dir/wiki/config.sample.yml"
rm -f \
  "$work_dir/wiki/node_modules/.modules.yaml" \
  "$work_dir/wiki/node_modules/.pnpm-workspace-state-v1.json"

tar \
  --sort=name \
  --format=gnu \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" \
  -cf - \
  -C "$work_dir/wiki" . \
  | gzip -n > "$output"
