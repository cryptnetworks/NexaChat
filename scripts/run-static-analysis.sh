#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo 'usage: run-static-analysis.sh OUTPUT_DIRECTORY [REPOSITORY]' >&2
  exit 2
fi

root="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root="$(cd "$root" && pwd)"
output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
scanner='semgrep/semgrep:1.170.0-nonroot@sha256:c63f1dbe9339bc95351bdaac80bf0d9b5abed37789a04eaa6dfa16c85a4687d3'

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --pids-limit 256 \
  --memory 2g \
  --cpus 2 \
  --env HOME=/tmp \
  --volume "$root:/src:ro" \
  --volume "$output_directory:/output" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=512m \
  "$scanner" semgrep scan \
  --config /src/.semgrep.yml \
  --error \
  --metrics=off \
  --disable-version-check \
  --no-git-ignore \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude dist-production \
  --sarif-output=/output/semgrep.sarif \
  /src

node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value.version!=='2.1.0'||!Array.isArray(value.runs))process.exit(1)" \
  "$output_directory/semgrep.sarif"

echo 'Pinned static security analysis passed.'
