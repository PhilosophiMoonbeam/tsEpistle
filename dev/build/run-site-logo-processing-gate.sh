#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: run-site-logo-processing-gate.sh IMAGE@DIGEST PLATFORM REPORT BUN_VERSION}
platform=${2:?Usage: run-site-logo-processing-gate.sh IMAGE@DIGEST PLATFORM REPORT BUN_VERSION}
report=${3:?Usage: run-site-logo-processing-gate.sh IMAGE@DIGEST PLATFORM REPORT BUN_VERSION}
expected_bun_version=${4:?Usage: run-site-logo-processing-gate.sh IMAGE@DIGEST PLATFORM REPORT BUN_VERSION}
expected_sharp_version=$(jq --exit-status --raw-output '.dependencies.sharp | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' package.json)

if [[ ! "$image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "Candidate image must be an exact digest descriptor: $image" >&2
  exit 1
fi

case "$platform" in
  linux/amd64)
    expected_bun_arch=x64
    ;;
  linux/arm64)
    expected_bun_arch=arm64
    ;;
  *)
    echo "Unsupported site-logo benchmark platform: $platform" >&2
    exit 1
    ;;
esac

report_directory=$(dirname "$report")
report_name=$(basename "$report")
mkdir -p "$report_directory"
chmod 0777 "$report_directory"
report_directory=$(realpath "$report_directory")
rm -f \
  "$report_directory/$report_name" \
  "$report_directory/candidate-image-descriptor.txt" \
  "$report_directory/site-logo-processing-benchmark.log"

docker pull --platform "$platform" "$image"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = "$platform"
configured_user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "${configured_user%%:*}" in
  ''|0|root)
    echo "Candidate image has a root default user: ${configured_user:-<unset>}" >&2
    exit 1
    ;;
esac
printf '%s\n' "$image" > "$report_directory/candidate-image-descriptor.txt"

if docker run --rm \
  --platform "$platform" \
  --pull never \
  --mount "type=bind,src=$report_directory,dst=/benchmark" \
  --env "SITE_LOGO_PROCESSING_BENCHMARK_FILE=/benchmark/$report_name" \
  "$image" \
  sh -ec 'test "$(id -u)" -ne 0; exec bun run benchmark:site-logo-processing' \
  2>&1 | tee "$report_directory/site-logo-processing-benchmark.log"; then
  benchmark_status=0
else
  benchmark_status=$?
fi

report="$report_directory/$report_name"
if [ ! -s "$report" ]; then
  echo "Site-logo processing benchmark exited without a diagnostic report at $report" >&2
  if [ "$benchmark_status" -eq 0 ]; then benchmark_status=1; fi
  exit "$benchmark_status"
fi

jq --exit-status \
  --arg expected_sharp_version "$expected_sharp_version" \
  --arg expected_architecture "$expected_bun_arch" \
  --arg expected_bun_version "$expected_bun_version" '
    (.reportVersion == 1)
    and (.environment.operatingSystem.platform == "linux")
    and (.environment.operatingSystem.architecture == $expected_architecture)
    and (.environment.runtime.name == "bun")
    and (.environment.runtime.version == $expected_bun_version)
    and (.environment.libraries.sharp == $expected_sharp_version)
    and (.environment.libraries.sharp | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+].*)?$"))
    and (.environment.libraries.libvips | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+].*)?$"))
  ' "$report"

if [ "$benchmark_status" -ne 0 ]; then
  echo "Site-logo processing benchmark failed in exact $platform candidate $image" >&2
  exit "$benchmark_status"
fi

jq --exit-status '
  . as $report
  | ($report.status == "passed")
    and ($report.thresholdViolations | length == 0)
    and ($report.cases | length > 0)
    and all($report.cases[];
      (.status == "passed")
      and (.thresholdViolations | length == 0)
      and (.durationMilliseconds.p95 <= $report.thresholds.maxCaseP95Milliseconds)
      and (.peakRssDeltaBytes.maximum <= $report.thresholds.maxCasePeakRssDeltaBytes)
    )
    and ($report.corpusWallMilliseconds <= $report.thresholds.maxCorpusWallMilliseconds)
  ' "$report"
