#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo 'security_fixture_error: an available Docker daemon is required' >&2
  exit 2
fi

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
secret_report="$report_directory/secret/gitleaks-history.sarif"
if [[ ! -s "$secret_report" ]]; then
  echo 'security_fixture_error: secret scanner failed without a report' >&2
  exit 1
fi
node - "$secret_report" <<'NODE'
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = (report.runs ?? []).flatMap((run) => run.results ?? []);
if (!results.some((result) => result.ruleId === 'controlled-fixture')) {
  process.stderr.write('security_fixture_error: expected secret finding is absent\n');
  process.exit(1);
}
if (JSON.stringify(report).includes('CONTROLLED_Q7X9M2V4K8R6T3W5')) {
  process.stderr.write('security_fixture_error: secret report was not redacted\n');
  process.exit(1);
}
NODE

find "$fixture" -mindepth 1 -depth -delete
mkdir -p "$fixture/.github/workflows"
git -C "$fixture" init --quiet
git -C "$fixture" config user.name 'NexaChat security fixture'
git -C "$fixture" config user.email 'security-fixture@example.invalid'
cp "$root/.gitleaks.toml" "$fixture/.gitleaks.toml"
printf '%s%s%s%s\n' \
  'services: { postgres: "17.10-alpine3.23", val' \
  'key' \
  ': "8.1.9-alpine3.24"' \
  ' },' > "$fixture/.github/workflows/release-candidate.yml"
git -C "$fixture" add .gitleaks.toml .github/workflows/release-candidate.yml
git -C "$fixture" commit --quiet -m 'test: public service-version evidence'

if ! bash "$root/scripts/run-secret-scan.sh" "$report_directory/public-evidence" "$fixture" >/dev/null 2>&1; then
  echo 'security_fixture_error: exact public service-version evidence was not allowlisted' >&2
  exit 1
fi

printf '%s%s%s%s%s%s\n' \
  'github_token = "' \
  'ghp' \
  '_' \
  'Q7X9M2V4K8R6T3W5' \
  'P1L3N5C7B9D2F4H6J8K0' \
  '"' >> "$fixture/.github/workflows/release-candidate.yml"
git -C "$fixture" add .github/workflows/release-candidate.yml
git -C "$fixture" commit --quiet -m 'test: controlled credential beside public evidence'

if bash "$root/scripts/run-secret-scan.sh" "$report_directory/allowlist-boundary" "$fixture" >/dev/null 2>&1; then
  echo 'security_fixture_error: allowlist masked a controlled credential' >&2
  exit 1
fi
allowlist_report="$report_directory/allowlist-boundary/gitleaks-history.sarif"
if [[ ! -s "$allowlist_report" ]]; then
  echo 'security_fixture_error: allowlist-boundary scan failed without a report' >&2
  exit 1
fi
node - "$allowlist_report" <<'NODE'
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = (report.runs ?? []).flatMap((run) => run.results ?? []);
if (!results.some((result) => result.ruleId === 'github-pat')) {
  process.stderr.write('security_fixture_error: credential beside allowlisted evidence was not detected\n');
  process.exit(1);
}
const controlledCredential = [
  'ghp',
  '_',
  'Q7X9M2V4K8R6T3W5',
  'P1L3N5C7B9D2F4H6J8K0',
].join('');
if (JSON.stringify(report).includes(controlledCredential)) {
  process.stderr.write('security_fixture_error: allowlist-boundary report was not redacted\n');
  process.exit(1);
}
NODE

find "$fixture" -mindepth 1 -depth -delete
mkdir -p "$fixture"
cp "$root/.semgrep.yml" "$fixture/.semgrep.yml"
printf '%s\n' 'export function unsafe(input: string) {' '  return eval(input);' '}' > "$fixture/unsafe.ts"

if bash "$root/scripts/run-static-analysis.sh" "$report_directory/static" "$fixture" >/dev/null 2>&1; then
  echo 'security_fixture_error: controlled static finding was not detected' >&2
  exit 1
fi
static_report="$report_directory/static/semgrep.sarif"
if [[ ! -s "$static_report" ]]; then
  echo 'security_fixture_error: static scanner failed without a report' >&2
  exit 1
fi
node - "$static_report" <<'NODE'
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = (report.runs ?? []).flatMap((run) => run.results ?? []);
if (
  !results.some((result) =>
    String(result.ruleId ?? '').endsWith('nexa-javascript-eval'),
  )
) {
  process.stderr.write('security_fixture_error: expected static finding is absent\n');
  process.exit(1);
}
NODE

echo 'Controlled secret and static-analysis fixtures produced the expected findings.'
