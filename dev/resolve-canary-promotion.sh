#!/usr/bin/env bash
set -euo pipefail

format=json
case "${1:-}" in
  '') ;;
  --format=json) ;;
  --format=env) format=env ;;
  *)
    echo "usage: $0 [--format=json|--format=env]" >&2
    exit 2
    ;;
esac

promotion_repository="${WIKI_CANARY_PROMOTION_REPOSITORY:-ghcr.io/philosophimoonbeam/wiki-canary-promotion}"
application_repository="${WIKI_IMAGE_REPOSITORY:-ghcr.io/philosophimoonbeam/wiki}"
agent_browser_repository="${WIKI_AGENT_BROWSER_IMAGE_REPOSITORY:-${application_repository}-agent-browser}"
for repository in "$promotion_repository" "$application_repository" "$agent_browser_repository"; do
  if [[ ! "$repository" =~ ^[a-z0-9][a-z0-9./:_-]*[a-z0-9]$ ]]; then
    echo "Invalid OCI repository: $repository" >&2
    exit 2
  fi
done
pointer_reference="${promotion_repository}:canary-set"

pointer_manifest="$(docker buildx imagetools inspect "$pointer_reference" --raw)"
revision="$(jq -er '.annotations["io.tsepistle.canary-promotion.main-sha"]' <<<"$pointer_manifest")"
application_amd64="$(jq -er '.annotations["io.tsepistle.canary-promotion.application-amd64"]' <<<"$pointer_manifest")"
application_arm64="$(jq -er '.annotations["io.tsepistle.canary-promotion.application-arm64"]' <<<"$pointer_manifest")"
agent_browser_amd64="$(jq -er '.annotations["io.tsepistle.canary-promotion.agent-browser-amd64"]' <<<"$pointer_manifest")"
agent_browser_arm64="$(jq -er '.annotations["io.tsepistle.canary-promotion.agent-browser-arm64"]' <<<"$pointer_manifest")"

jq -e \
  --arg revision "$revision" \
  --arg application_amd64 "$application_amd64" \
  --arg application_arm64 "$application_arm64" \
  --arg agent_browser_amd64 "$agent_browser_amd64" \
  --arg agent_browser_arm64 "$agent_browser_arm64" \
  --arg application_repository "$application_repository" \
  --arg agent_browser_repository "$agent_browser_repository" '
    (.annotations["io.tsepistle.canary-promotion.schema-version"] == "1")
    and ($revision | test("^[0-9a-f]{40}$"))
    and (.annotations["org.opencontainers.image.revision"] == $revision)
    and ($application_amd64 | startswith($application_repository + "@sha256:"))
    and (($application_amd64 | ltrimstr($application_repository + "@")) | test("^sha256:[0-9a-f]{64}$"))
    and ($application_arm64 | startswith($application_repository + "@sha256:"))
    and (($application_arm64 | ltrimstr($application_repository + "@")) | test("^sha256:[0-9a-f]{64}$"))
    and ($agent_browser_amd64 | startswith($agent_browser_repository + "@sha256:"))
    and (($agent_browser_amd64 | ltrimstr($agent_browser_repository + "@")) | test("^sha256:[0-9a-f]{64}$"))
    and ($agent_browser_arm64 | startswith($agent_browser_repository + "@sha256:"))
    and (($agent_browser_arm64 | ltrimstr($agent_browser_repository + "@")) | test("^sha256:[0-9a-f]{64}$"))
  ' <<<"$pointer_manifest" >/dev/null

immutable_manifest="$(docker buildx imagetools inspect "$promotion_repository:$revision" --raw)"
if [[ "$immutable_manifest" != "$pointer_manifest" ]]; then
  echo "Canary set pointer does not match immutable promotion record $promotion_repository:$revision." >&2
  exit 1
fi

record="$(jq -cn \
  --arg revision "$revision" \
  --arg application_amd64 "$application_amd64" \
  --arg application_arm64 "$application_arm64" \
  --arg agent_browser_amd64 "$agent_browser_amd64" \
  --arg agent_browser_arm64 "$agent_browser_arm64" '
    {
      schemaVersion: 1,
      mainSha: $revision,
      images: {
        application: {amd64: $application_amd64, arm64: $application_arm64},
        agentBrowser: {amd64: $agent_browser_amd64, arm64: $agent_browser_arm64}
      }
    }
  ')"

if [[ "$format" == json ]]; then
  printf '%s\n' "$record"
  exit 0
fi

architecture="${WIKI_CANARY_ARCHITECTURE:-$(uname -m)}"
case "$architecture" in
  amd64|x86_64)
    selected_application="$application_amd64"
    selected_agent_browser="$agent_browser_amd64"
    ;;
  arm64|aarch64)
    selected_application="$application_arm64"
    selected_agent_browser="$agent_browser_arm64"
    ;;
  *)
    echo "Unsupported canary deployment architecture: $architecture" >&2
    exit 1
    ;;
esac

printf "export WIKI_CANARY_MAIN_SHA='%s'\n" "$revision"
printf "export WIKI_CANARY_APPLICATION_AMD64='%s'\n" "$application_amd64"
printf "export WIKI_CANARY_APPLICATION_ARM64='%s'\n" "$application_arm64"
printf "export WIKI_CANARY_AGENT_BROWSER_AMD64='%s'\n" "$agent_browser_amd64"
printf "export WIKI_CANARY_AGENT_BROWSER_ARM64='%s'\n" "$agent_browser_arm64"
printf "export WIKI_IMAGE='%s'\n" "$selected_application"
printf "export WIKI_AGENT_BROWSER_IMAGE='%s'\n" "$selected_agent_browser"
