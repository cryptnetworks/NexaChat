#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo 'usage: run-secret-scan.sh OUTPUT_DIRECTORY [REPOSITORY]' >&2
  exit 2
fi

root="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
root="$(cd "$root" && pwd)"
output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd "$output_directory" && pwd)"
work_directory="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-secret-scan.XXXXXX")"
scan_repository="$work_directory/repository"
scanner='zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
runtime_user="$(id -u):$(id -g)"

cleanup() {
  find "$work_directory" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

git -C "$root" rev-parse --is-inside-work-tree >/dev/null
revision="$(git -C "$root" rev-parse HEAD)"
git clone --quiet --no-hardlinks "$root" "$scan_repository"
git -C "$scan_repository" checkout --quiet --detach "$revision"

common=(
  --rm
  --user "$runtime_user"
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --network none
  --pids-limit 128
  --memory 512m
  --cpus 2
  --volume "$output_directory:/output"
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=64m
)

docker run "${common[@]}" --volume "$scan_repository:/repo:ro" "$scanner" git \
  --redact=100 --no-banner --report-format=sarif \
  --report-path=/output/gitleaks-history.sarif /repo
docker run "${common[@]}" --volume "$root:/repo:ro" "$scanner" dir \
  --redact=100 --no-banner --report-format=sarif \
  --report-path=/output/gitleaks-worktree.sarif /repo

node -e "const fs=require('node:fs');for(const file of process.argv.slice(1)){const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version!=='2.1.0'||!Array.isArray(value.runs))process.exit(1)}" \
  "$output_directory/gitleaks-history.sarif" \
  "$output_directory/gitleaks-worktree.sarif"

echo 'Repository history and working tree secret scans passed.'
