#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-development-verify-$$"
port_offset=$(( $$ % 1000 ))
server_port=$(( 42000 + port_offset ))
web_port=$(( 44000 + port_offset ))
cookie_jar="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-development-cookie.XXXXXX")"
compose=(
  docker compose
  -f docker-compose.yml
  -f compose.development.yml
  -p "$project"
  --profile applications
)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$cookie_jar"
}
trap cleanup EXIT INT TERM

fail() {
  echo "development_container_error: $1" >&2
  "${compose[@]}" ps >&2 || true
  exit 1
}

inspect_service() {
  local service="$1"
  local format="$2"
  local container_id
  container_id="$("${compose[@]}" ps --all -q "$service")"
  [[ -n "$container_id" ]] || fail "$service container is missing"
  docker inspect --format "$format" "$container_id"
}

cd "$root"
export NEXA_DEVELOPMENT_IMAGE_TAG="verify-$$"
export NEXA_DEVELOPMENT_SERVER_PORT="$server_port"
export NEXA_DEVELOPMENT_WEB_PORT="$web_port"

"${compose[@]}" config --quiet
"${compose[@]}" up --detach --build --wait --wait-timeout 240

server_ports="$(docker port "$("${compose[@]}" ps -q server)")"
web_ports="$(docker port "$("${compose[@]}" ps -q web)")"
[[ "$server_ports" == "3000/tcp -> 127.0.0.1:${server_port}" ]] ||
  fail 'server has an unexpected published port'
[[ "$web_ports" == "5173/tcp -> 127.0.0.1:${web_port}" ]] ||
  fail 'web has an unexpected published port'
for service in postgres redis object-storage; do
  [[ -z "$(docker port "$("${compose[@]}" ps -q "$service")")" ]] ||
    fail "$service is published by the application profile"
done

server_image="$(inspect_service server '{{.Image}}')"
web_image="$(inspect_service web '{{.Image}}')"
[[ "$server_image" == "$web_image" ]] ||
  fail 'development services do not reuse the reviewed image'
for service in server web; do
  runtime_user="$(inspect_service "$service" '{{.Config.User}}')"
  [[ -n "$runtime_user" && "$runtime_user" != 0 && "$runtime_user" != root ]] ||
    fail "$service runs as root"
  [[ "$(inspect_service "$service" '{{.HostConfig.ReadonlyRootfs}}')" == true ]] ||
    fail "$service root filesystem is writable"
done

server_mounts="$(inspect_service server '{{range .Mounts}}{{println .Destination .RW}}{{end}}')"
web_mounts="$(inspect_service web '{{range .Mounts}}{{println .Destination .RW}}{{end}}')"
[[ "$server_mounts" == *'/workspace/apps/server/src false'* ]] ||
  fail 'server source mount is not read-only'
[[ "$web_mounts" == *'/workspace/apps/web/src false'* ]] ||
  fail 'web source mount is not read-only'
[[ "$server_mounts" != *'/workspace/node_modules'* ]] ||
  fail 'server dependency directory is host-mounted'
[[ "$web_mounts" != *'/workspace/node_modules'* ]] ||
  fail 'web dependency directory is host-mounted'

"${compose[@]}" exec -T server node -e \
  "const fs=require('node:fs');let denied=false;try{fs.writeFileSync('/workspace/apps/server/src/.nexa-write-test','x')}catch(error){denied=error.code==='EROFS'||error.code==='EACCES'}if(!denied)process.exit(1);fs.writeFileSync('/tmp/nexa-write-test','x');fs.unlinkSync('/tmp/nexa-write-test')" ||
  fail 'server write boundary is invalid'

origin="http://localhost:${web_port}"
public_endpoint="http://127.0.0.1:${web_port}"
curl --fail --silent --show-error --max-time 10 "$public_endpoint/" |
  grep -q '<div id="root"' || fail 'web application is unavailable'
curl --fail --silent --show-error --max-time 10 "$public_endpoint/health/live" |
  grep -qx '{"status":"ok"}' || fail 'proxied liveness is invalid'
curl --fail --silent --show-error --max-time 10 "$public_endpoint/health/ready" |
  grep -qx '{"status":"ready"}' || fail 'proxied readiness is invalid'

username="container$$"
password="Container-$(node -e "process.stdout.write(require('node:crypto').randomBytes(12).toString('hex'))")"
printf '{"username":"%s","displayName":"Container verification","password":"%s"}' \
  "$username" "$password" |
  curl --fail --silent --show-error --max-time 15 \
    --cookie-jar "$cookie_jar" \
    --header 'Content-Type: application/json' \
    --header "Origin: $origin" \
    --data-binary @- \
    "$public_endpoint/v1/auth/register" |
  grep -q "\"username\":\"${username}\"" ||
  fail 'proxied registration failed'
curl --fail --silent --show-error --max-time 10 \
  --cookie "$cookie_jar" "$public_endpoint/v1/account" |
  grep -q "\"username\":\"${username}\"" ||
  fail 'proxied authenticated request failed'
session_cookie="$(awk '$6 == "nexa_session" { print $6 "=" $7 }' "$cookie_jar" | tail -n 1)"
[[ -n "$session_cookie" ]] || fail 'development session cookie was not issued'

"${compose[@]}" exec -T \
  -e "NEXA_VERIFY_COOKIE=$session_cookie" \
  -e "NEXA_VERIFY_ORIGIN=$origin" \
  web node --input-type=module <<'NODE' || fail 'proxied WebSocket heartbeat failed'
import { WebSocket } from 'ws';

const socket = new WebSocket('ws://127.0.0.1:5173/v1/realtime', {
  origin: process.env.NEXA_VERIFY_ORIGIN,
  headers: { cookie: process.env.NEXA_VERIFY_COOKIE },
  handshakeTimeout: 10_000,
});
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('development websocket verification timed out'));
  }, 15_000);
  socket.once('open', () => {
    socket.send(JSON.stringify({ version: 1, type: 'heartbeat' }));
  });
  socket.once('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (
        message.version !== 1 ||
        message.type !== 'heartbeat' ||
        typeof message.occurredAt !== 'string'
      )
        throw new Error('unexpected development websocket response');
      clearTimeout(timeout);
      socket.close(1000, 'verified');
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      socket.terminate();
      reject(error);
    }
  });
  socket.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});
NODE

"${compose[@]}" stop --timeout 15 server
[[ "$(inspect_service server '{{.State.ExitCode}}')" == 0 ]] ||
  fail 'server did not stop cleanly'
server_logs="$("${compose[@]}" logs --no-color server)"
[[ "$server_logs" == *'"event":"shutdown.signal"'* ]] ||
  fail 'server shutdown signal was not recorded'
[[ "$server_logs" == *'"event":"shutdown.completed"'* ]] ||
  fail 'server shutdown did not complete'
"${compose[@]}" up --detach --wait --wait-timeout 120 server web
curl --fail --silent --show-error --max-time 10 \
  --cookie "$cookie_jar" "$public_endpoint/v1/account" |
  grep -q "\"username\":\"${username}\"" ||
  fail 'durable account or session did not survive server restart'

logs="$("${compose[@]}" logs --no-color server web)"
for sensitive_value in \
  local-development-password \
  change-this-local-secret \
  "$password" \
  "${session_cookie#*=}"; do
  [[ "$logs" != *"$sensitive_value"* ]] ||
    fail 'sensitive value appeared in application container logs'
done

echo 'Containerized server/web development, private providers, HTTP/WebSocket proxying, non-root read-only execution, restart persistence, and cleanup verified.'
