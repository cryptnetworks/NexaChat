#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-clean-verify-$$"
server_pid=''
log_file="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-clean-verify.XXXXXX")"
port_offset=$(( $$ % 500 ))
server_port=$(( 31000 + port_offset ))
postgres_port=$(( 55000 + port_offset ))
valkey_port=$(( 56000 + port_offset ))
minio_api_port=$(( 57000 + port_offset ))
minio_console_port=$(( 58000 + port_offset ))

process_exited() {
  local pid="$1"
  local state
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ "$state" == Z* ]]
}

wait_for_exit() {
  local pid="$1"
  local attempts="$2"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if process_exited "$pid"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

terminate_server() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true
  if wait_for_exit "$pid" 20; then
    wait "$pid" 2>/dev/null || true
    return
  fi
  kill -KILL "$pid" 2>/dev/null || true
  if wait_for_exit "$pid" 20; then
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "$server_pid" ]]; then
    terminate_server "$server_pid"
  fi
  docker compose -p "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$log_file"
}
trap cleanup EXIT INT TERM

expect_status() {
  local expected="$1"
  local phase="$2"
  local status='000'
  for _ in {1..30}; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "http://127.0.0.1:${server_port}/health/ready" || true)"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "clean_environment_error: $phase expected HTTP $expected, received $status" >&2
  sed -n '1,160p' "$log_file" >&2 || true
  return 1
}

expect_body() {
  local endpoint="$1"
  local expected="$2"
  local body=''
  for _ in {1..30}; do
    body="$(curl --silent --show-error --max-time 10 "http://127.0.0.1:${server_port}${endpoint}" || true)"
    if [[ "$body" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "clean_environment_error: $endpoint expected $expected, received $body" >&2
  sed -n '1,160p' "$log_file" >&2 || true
  return 1
}

cd "$root"
bash scripts/check-toolchain.sh
npm ci --ignore-scripts
docker compose config --quiet

export POSTGRES_PUBLISHED_PORT="$postgres_port"
export VALKEY_PUBLISHED_PORT="$valkey_port"
export MINIO_API_PUBLISHED_PORT="$minio_api_port"
export MINIO_CONSOLE_PUBLISHED_PORT="$minio_console_port"
export DATABASE_URL="postgresql://nexa:local-development-password@127.0.0.1:${postgres_port}/nexa"
export NEXA_SERVER_PORT="$server_port"
export NEXA_SERVER_HOST=127.0.0.1
export NEXA_WEB_ORIGIN=http://localhost:5173
export NEXA_SECURE_COOKIES=false
export NODE_ENV=development
export NEXA_COORDINATION_ENABLED=true
export REDIS_URL="redis://127.0.0.1:${valkey_port}"
export NEXA_OBJECT_STORAGE_ENABLED=true
export NEXA_OBJECT_STORAGE_CREATE_BUCKET=true
export S3_ENDPOINT="http://127.0.0.1:${minio_api_port}"
export S3_ACCESS_KEY='nexa-local'
export S3_SECRET_KEY='change-this-local-secret'
export S3_BUCKET='nexa-observability-verify'
export S3_REGION='us-east-1'

docker compose -p "$project" up -d --wait postgres redis object-storage
npm run migrate
node --import tsx apps/server/src/main.ts > "$log_file" 2>&1 &
server_pid="$!"

expect_status 200 'initial readiness'
expect_body '/health/live' '{"status":"ok"}'
expect_body '/health/startup' '{"status":"started"}'
expect_body '/health/ready' '{"status":"ready"}'
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${server_port}/metrics" \
  | grep -q 'nexa_process_lifecycle'
docker compose -p "$project" stop postgres >/dev/null
expect_status 503 'dependency outage'
expect_body '/health/live' '{"status":"ok"}'
expect_body '/health/startup' '{"status":"started"}'
docker compose -p "$project" up -d --wait postgres >/dev/null
expect_status 200 'dependency recovery'

docker compose -p "$project" stop redis >/dev/null
expect_status 200 'coordination degradation'
expect_body '/health/ready' '{"status":"degraded"}'
docker compose -p "$project" up -d --wait redis >/dev/null
expect_body '/health/ready' '{"status":"ready"}'

docker compose -p "$project" stop object-storage >/dev/null
expect_status 200 'object storage degradation'
expect_body '/health/ready' '{"status":"degraded"}'
docker compose -p "$project" up -d --wait object-storage >/dev/null
expect_body '/health/ready' '{"status":"ready"}'

kill -TERM "$server_pid"
if ! wait_for_exit "$server_pid" 100; then
  echo 'clean_environment_error: server exceeded its shutdown deadline' >&2
  exit 1
fi
wait "$server_pid"
server_pid=''
grep -q '"event":"shutdown.signal".*"signal":"SIGTERM"' "$log_file"
grep -q '"event":"shutdown.completed"' "$log_file"
if grep -Eq 'local-development-password|change-this-local-secret|nexa-observability-verify' "$log_file"; then
  echo 'clean_environment_error: private configuration appeared in logs' >&2
  exit 1
fi

echo 'Clean startup, dependency recovery, telemetry, and shutdown verified.'
