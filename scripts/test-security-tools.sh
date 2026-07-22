#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-security-fixture.XXXXXX")"
report_directory="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-security-reports.XXXXXX")"

cleanup() {
  find "$fixture" -depth -delete 2>/dev/null || true
  find "$report_directory" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT INT TERM

git -C "$fixture" init --quiet
git -C "$fixture" config user.name 'NexaChat security fixture'
git -C "$fixture" config user.email 'security-fixture@example.invalid'
printf '%s\n' \
  'title = "Controlled fixture"' \
  '[[rules]]' \
  'id = "controlled-fixture"' \
  'description = "Controlled fixture"' \
  "regex = '''CONTROLLED_[A-Z0-9]{16}'''" > "$fixture/.gitleaks.toml"
printf '%s%s\n' 'CONTROLLED_' 'Q7X9M2V4K8R6T3W5' > "$fixture/credential.txt"
git -C "$fixture" add .gitleaks.toml credential.txt
git -C "$fixture" commit --quiet -m 'test: controlled secret fixture'

if bash "$root/scripts/run-secret-scan.sh" "$report_directory/secret" "$fixture" >/dev/null 2>&1; then
  echo 'security_fixture_error: controlled secret was not detected' >&2
  exit 1
fi

find "$fixture" -mindepth 1 -depth -delete
mkdir -p "$fixture"
cp "$root/.semgrep.yml" "$fixture/.semgrep.yml"
printf '%s\n' 'export function unsafe(input: string) {' '  return eval(input);' '}' > "$fixture/unsafe.ts"

if bash "$root/scripts/run-static-analysis.sh" "$report_directory/static" "$fixture" >/dev/null 2>&1; then
  echo 'security_fixture_error: controlled static finding was not detected' >&2
  exit 1
fi

echo 'Controlled secret and static-analysis fixtures were rejected.'
