#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-browser-e2e-$$"
api_pid=''
web_pid=''
api_log="$(mktemp "${TMPDIR:-/tmp}/nexa-browser-e2e-api.XXXXXX")"
web_log="$(mktemp "${TMPDIR:-/tmp}/nexa-browser-e2e-web.XXXXXX")"
cache_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-browser-e2e-vite.XXXXXX")"
result_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-browser-e2e-results.XXXXXX")"
offset=$(( $$ % 500 ))
api_port=$(( 32000 + offset ))
web_port=$(( 33000 + offset ))

process_exited() {
  local pid="$1"
  local state
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ "$state" == Z* ]]
}

terminate_process() {
  local pid="$1"
  local attempt
  kill -TERM "$pid" 2>/dev/null || true
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    if process_exited "$pid"; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ -n "$web_pid" ]]; then
    terminate_process "$web_pid"
  fi
  if [[ -n "$api_pid" ]]; then
    terminate_process "$api_pid"
  fi
  docker compose -p "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$api_log" "$web_log"
  rm -rf "$cache_dir"
  rm -rf "$result_dir"
}
trap cleanup EXIT INT TERM

wait_for_status() {
  local url="$1"
  local expected="$2"
  local attempt
  local status='000'
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "$url" || true)"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "browser_e2e_error: expected HTTP $expected from the disposable local service" >&2
  return 1
}

redacted_log() {
  local path="$1"
  sed -E \
    -e 's#postgresql://[^@[:space:]]+@#postgresql://[redacted]@#g' \
    -e 's/local-development-password/[redacted]/g' \
    -e 's/change-this-local-secret/[redacted]/g' \
    "$path"
}

published_port() {
  local endpoint
  local port
  endpoint="$(docker compose -p "$project" port postgres 5432)"
  endpoint="${endpoint%%$'\n'*}"
  port="${endpoint##*:}"
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo 'browser_e2e_error: PostgreSQL did not receive a published port' >&2
    return 1
  fi
  printf '%s' "$port"
}

cd "$root"
bash scripts/check-toolchain.sh

export POSTGRES_PUBLISHED_PORT=23000-23499
docker compose -p "$project" up -d --wait postgres
postgres_port="$(published_port)"

export DATABASE_URL="postgresql://nexa:local-development-password@127.0.0.1:${postgres_port}/nexa"
export MIGRATION_DATABASE_URL="$DATABASE_URL"
export NEXA_SERVER_HOST=127.0.0.1
export NEXA_SERVER_PORT="$api_port"
export NEXA_WEB_ORIGIN="http://127.0.0.1:${web_port}"
export NEXA_SECURE_COOKIES=false
export NEXA_COORDINATION_ENABLED=false
export NEXA_OBJECT_STORAGE_ENABLED=false

(unset DATABASE_URL; npm run migrate) >/dev/null
node --import tsx apps/server/src/main.ts >"$api_log" 2>&1 &
api_pid="$!"
if ! wait_for_status "http://127.0.0.1:${api_port}/health/ready" 200; then
  redacted_log "$api_log" >&2
  exit 1
fi

NEXA_DEV_CACHE_DIR="$cache_dir" \
  NEXA_DEV_PROXY_TARGET="http://127.0.0.1:${api_port}" \
  npm run dev --workspace @nexa/web -- --host 127.0.0.1 --port "$web_port" \
  >"$web_log" 2>&1 &
web_pid="$!"
if ! wait_for_status "http://127.0.0.1:${web_port}/" 200; then
  redacted_log "$web_log" >&2
  exit 1
fi

NEXA_E2E_BASE_URL="http://127.0.0.1:${web_port}" \
  NEXA_E2E_OUTPUT_DIR="$result_dir" \
  NEXA_E2E_RUN_ID="$$" \
  npx playwright test --config apps/web/playwright.system.config.ts

echo 'Browser end-to-end verification passed against a disposable live service stack.'
