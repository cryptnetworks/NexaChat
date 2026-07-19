#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo 'usage: scan-production-images.sh OUTPUT_DIRECTORY IMAGE [IMAGE ...]' >&2
  exit 2
fi

output_directory="$1"
shift
mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
work_directory="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-image-scan.XXXXXX")"
cache_directory="$work_directory/cache"
mkdir -m 0700 "$cache_directory"
scanner='aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e'
runtime_user="$(id -u):$(id -g)"
scan_failed=0

cleanup() {
  find "$work_directory" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for image in "$@"; do
  docker image inspect "$image" >/dev/null
  name="$(printf '%s' "$image" | tr -cs 'A-Za-z0-9._-' '_' | sed 's/^_*//; s/_*$//')"
  archive="$work_directory/${name}.tar"
  sbom="$output_directory/${name}.cdx.json"
  vulnerability_report="$output_directory/${name}.vulnerabilities.json"
  docker image save --output "$archive" "$image"

  common=(
    --rm
    --user "$runtime_user"
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges
    --pids-limit 256
    --memory 2g
    --cpus 2
    --env HOME=/tmp
    --env TRIVY_CACHE_DIR=/cache
    --volume "$archive:/image.tar:ro"
    --volume "$cache_directory:/cache"
    --volume "$output_directory:/output"
    --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=512m
  )

  if ! docker run "${common[@]}" "$scanner" image \
    --input /image.tar \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --no-progress \
    --skip-version-check \
    --disable-telemetry \
    --format json \
    --output "/output/$(basename "$vulnerability_report")" \
    --exit-code 1; then
    printf 'production_image_vulnerability_error: %s\n' "$image" >&2
    scan_failed=1
  fi
  node -e "const fs=require('node:fs');const image=process.argv[1];const value=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(!Array.isArray(value.Results))process.exit(1);const findings=value.Results.flatMap((result)=>result.Vulnerabilities??[]);const high=findings.filter((finding)=>finding.Severity==='HIGH').length;const critical=findings.filter((finding)=>finding.Severity==='CRITICAL').length;process.stdout.write(image+': HIGH='+high+' CRITICAL='+critical+'\n')" "$image" "$vulnerability_report"
  docker run "${common[@]}" \
    "$scanner" image \
    --input /image.tar \
    --no-progress \
    --skip-version-check \
    --disable-telemetry \
    --format cyclonedx \
    --output "/output/$(basename "$sbom")"
  node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value.bomFormat!=='CycloneDX'||!Array.isArray(value.components)||value.components.length===0)process.exit(1)" "$sbom"
done

if [[ "$scan_failed" -ne 0 ]]; then
  echo 'One or more production images contain HIGH or CRITICAL vulnerabilities.' >&2
  exit 1
fi

echo 'Production image vulnerability scans and CycloneDX SBOM validation passed.'
