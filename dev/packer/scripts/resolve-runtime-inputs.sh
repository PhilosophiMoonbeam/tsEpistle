#!/bin/bash
set -euo pipefail

: "${DO_TOKEN:?DO_TOKEN is required}"
: "${APT_SNAPSHOT:?APT_SNAPSHOT is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

if [[ ! "$APT_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "APT_SNAPSHOT must be an Ubuntu snapshot timestamp in YYYYMMDDTHHMMSSZ format" >&2
  exit 1
fi

base_image_slug="ubuntu-24-04-x64"
postgres_tag="docker.io/library/postgres:17"
packer_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
inputs_dir="$packer_dir/runtime-inputs"
packages_dir="$inputs_dir/docker-packages"
mkdir -p "$inputs_dir"
rm -rf "$packages_dir" "$inputs_dir/docker-packages.tar" "$inputs_dir/runtime-inputs.json"
mkdir -p "$packages_dir"

base_images_file="$(mktemp)"
postgres_tag_manifest="$(mktemp)"
postgres_digest_manifest="$(mktemp)"
trap 'rm -f "$base_images_file" "$postgres_tag_manifest" "$postgres_digest_manifest"' EXIT

curl --fail --silent --show-error --location \
  --header "Authorization: Bearer $DO_TOKEN" \
  --header "Content-Type: application/json" \
  "https://api.digitalocean.com/v2/images?type=distribution&per_page=200" > "$base_images_file"
base_image_id="$(jq -er --arg slug "$base_image_slug" '
  [.images[] | select(.slug == $slug)]
  | if length == 1 then .[0].id | tostring else error("expected exactly one DigitalOcean base image") end
' "$base_images_file")"
if [[ ! "$base_image_id" =~ ^[1-9][0-9]*$ ]]; then
  echo "DigitalOcean returned an invalid base image ID for $base_image_slug" >&2
  exit 1
fi

for suite in noble noble-updates noble-backports noble-security; do
  curl --fail --silent --show-error --location --retry 3 \
    --output /dev/null \
    "https://snapshot.ubuntu.com/ubuntu/$APT_SNAPSHOT/dists/$suite/InRelease"
done

docker buildx imagetools inspect "$postgres_tag" --raw > "$postgres_tag_manifest"
postgres_digest="sha256:$(sha256sum "$postgres_tag_manifest" | cut -d ' ' -f 1)"
if [[ ! "$postgres_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Could not resolve an immutable PostgreSQL image digest" >&2
  exit 1
fi
postgres_image="docker.io/library/postgres@$postgres_digest"
docker buildx imagetools inspect "$postgres_image" --raw > "$postgres_digest_manifest"
if ! cmp --silent "$postgres_tag_manifest" "$postgres_digest_manifest"; then
  echo "PostgreSQL tag changed while its immutable digest was being resolved" >&2
  exit 1
fi

# Resolve Docker's five runtime packages in an isolated Noble apt client. The
# downloaded .deb files, rather than the mutable Docker apt repository, are the
# only Docker package inputs copied into the Packer build.
docker run --rm --platform linux/amd64 \
  --env APT_SNAPSHOT="$APT_SNAPSHOT" \
  --volume "$packages_dir:/out" \
  ubuntu:24.04 \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    cat > /etc/apt/sources.list.d/ubuntu.sources <<EOF
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/${APT_SNAPSHOT}/
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Check-Valid-Until: no
EOF
    apt-get -qq update
    apt-get -qqy install ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get -qq update
    cd /out
    for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
      apt-get -qq download "${package}:amd64"
    done
    : > package-manifest.tsv
    for archive in ./*.deb; do
      package="$(dpkg-deb --field "$archive" Package)"
      version="$(dpkg-deb --field "$archive" Version)"
      architecture="$(dpkg-deb --field "$archive" Architecture)"
      filename="${package}_${architecture}.deb"
      mv "$archive" "$filename"
      digest="$(sha256sum "$filename" | cut -d " " -f 1)"
      printf "%s\t%s\t%s\t%s\t%s\n" "$package" "$version" "$architecture" "$filename" "$digest" >> package-manifest.tsv
    done
    chmod -R a+rX /out
  '

jq -Rn '
  [inputs | split("\t") | {
    package: .[0],
    version: .[1],
    architecture: .[2],
    file: .[3],
    sha256: .[4]
  }] | sort_by(.package)
' < "$packages_dir/package-manifest.tsv" > "$packages_dir/docker-packages.json"
rm "$packages_dir/package-manifest.tsv"

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
    (.version | type == "string" and length > 0)
    and .architecture == "amd64"
    and (.file | test("^[A-Za-z0-9.+:~_-]+\\.deb$"))
    and (.sha256 | test("^[0-9a-f]{64}$"))
  )
' "$packages_dir/docker-packages.json" >/dev/null

while IFS=$'\t' read -r digest filename; do
  printf '%s  %s\n' "$digest" "$packages_dir/$filename"
done < <(jq -r '.[] | [.sha256, .file] | @tsv' "$packages_dir/docker-packages.json") \
  | sha256sum --check --strict

docker_package_manifest_sha256="$(sha256sum "$packages_dir/docker-packages.json" | cut -d ' ' -f 1)"
tar -C "$inputs_dir" -cf "$inputs_dir/docker-packages.tar" docker-packages

jq -n \
  --arg base_image_slug "$base_image_slug" \
  --arg base_image_id "$base_image_id" \
  --arg apt_snapshot "$APT_SNAPSHOT" \
  --arg postgres_tag "$postgres_tag" \
  --arg postgres_image "$postgres_image" \
  --arg postgres_digest "$postgres_digest" \
  --arg docker_package_manifest_sha256 "$docker_package_manifest_sha256" \
  --slurpfile docker_packages "$packages_dir/docker-packages.json" '
  {
    schemaVersion: 1,
    digitalOceanBaseImage: {
      slug: $base_image_slug,
      id: $base_image_id
    },
    ubuntuAptSnapshot: {
      id: $apt_snapshot,
      url: ("https://snapshot.ubuntu.com/ubuntu/" + $apt_snapshot + "/")
    },
    postgresqlImage: {
      sourceTag: $postgres_tag,
      reference: $postgres_image,
      digest: $postgres_digest
    },
    dockerPackages: {
      manifestSha256: $docker_package_manifest_sha256,
      packages: $docker_packages[0]
    }
  }
' > "$inputs_dir/runtime-inputs.json"

{
  echo "base_image_id=$base_image_id"
  echo "apt_snapshot=$APT_SNAPSHOT"
  echo "postgres_image=$postgres_image"
  echo "postgres_digest=$postgres_digest"
  echo "docker_package_manifest_sha256=$docker_package_manifest_sha256"
} >> "$GITHUB_OUTPUT"
