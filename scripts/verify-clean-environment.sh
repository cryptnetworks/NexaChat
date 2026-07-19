#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project='nexa-chat-clean-verify'
server_pid=''

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  docker compose -p "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f /tmp/nexa-chat-clean-verify.log
}
trap cleanup EXIT INT TERM

expect_status() {
  local expected="$1"
  local phase="$2"
  local status='000'
  for _ in {1..30}; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 http://127.0.0.1:3100/health/ready || true)"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "clean_environment_error: $phase expected HTTP $expected, received $status" >&2
  sed -n '1,120p' /tmp/nexa-chat-clean-verify.log >&2 || true
  return 1
}

cd "$root"
bash scripts/check-toolchain.sh
npm ci --ignore-scripts
docker compose config --quiet

export POSTGRES_PUBLISHED_PORT=55432
export DATABASE_URL='postgresql://nexa:local-development-password@127.0.0.1:55432/nexa'
export NEXA_SERVER_PORT=3100
export NEXA_SERVER_HOST=127.0.0.1
export NEXA_WEB_ORIGIN=http://localhost:5173
export NEXA_SECURE_COOKIES=false
export NODE_ENV=development

docker compose -p "$project" up -d --wait postgres
npm run migrate
node --import tsx apps/server/src/main.ts > /tmp/nexa-chat-clean-verify.log 2>&1 &
server_pid="$!"

expect_status 200 'initial readiness'
docker compose -p "$project" stop postgres >/dev/null
expect_status 503 'dependency outage'
docker compose -p "$project" up -d --wait postgres >/dev/null
expect_status 200 'dependency recovery'
echo 'Clean environment, dependency outage, and recovery verified.'
