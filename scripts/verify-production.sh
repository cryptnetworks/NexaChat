#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-production-verify-$$"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-production-secrets.XXXXXX")"
cookie_jar="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-production-cookie.XXXXXX")"
headers_file="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-production-headers.XXXXXX")"
logs_file="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-production-logs.XXXXXX")"
scan_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-production-scan.XXXXXX")"
negative_secret_dir=''
negative_container=''
negative_container_name=''
port=$(( 20000 + ($$ % 20000) ))
network_octet=$(( 16 + ($$ % 200) ))
frontend_subnet="10.231.${network_octet}.0/28"
backend_subnet="10.231.${network_octet}.16/28"
edge_address="10.231.${network_octet}.2"
server_address="10.231.${network_octet}.3"
public_host=chat.example.test
origin="https://${public_host}:${port}"
compose=(docker compose -f compose.production.yml -p "$project")
sensitive_values=()

cleanup() {
  if [[ -n "$negative_container" ]]; then
    negative_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$negative_container" 2>/dev/null || true)"
    negative_oneoff="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$negative_container" 2>/dev/null || true)"
    if [[ "$negative_project" == "$project" && "$negative_oneoff" == True ]]; then
      docker rm --force "$negative_container" >/dev/null 2>&1 || true
    fi
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$negative_secret_dir" ]]; then
    find "$negative_secret_dir" -type f -delete 2>/dev/null || true
    rmdir "$negative_secret_dir" 2>/dev/null || true
  fi
  find "$secret_dir" -type f -delete 2>/dev/null || true
  rmdir "$secret_dir" 2>/dev/null || true
  find "$scan_dir" -depth -delete 2>/dev/null || true
  rm -f "$cookie_jar" "$headers_file" "$logs_file"
}
trap cleanup EXIT INT TERM

fail() {
  echo "production_verification_error: $*" >&2
  "${compose[@]}" ps >&2 || true
  local redacted_logs
  redacted_logs="$("${compose[@]}" logs --no-color --tail 160 2>/dev/null || true)"
  for value in "${sensitive_values[@]}"; do
    [[ -n "$value" ]] && redacted_logs="${redacted_logs//"$value"/[REDACTED]}"
  done
  printf '%s\n' "$redacted_logs" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

random_secret() {
  openssl rand -hex 24
}

write_secret() {
  local name="$1"
  local value="$2"
  local directory="${3:-$secret_dir}"
  (umask 077 && printf '%s\n' "$value" > "$directory/$name")
}

inspect_value() {
  local service="$1"
  local template="$2"
  local container
  container="$("${compose[@]}" ps --all -q "$service")"
  [[ -n "$container" ]] || fail "$service container is missing"
  docker inspect --format "$template" "$container"
}

assert_hardened() {
  local service="$1"
  local expected_restart="$2"
  local cap_add
  [[ "$(inspect_value "$service" '{{.HostConfig.ReadonlyRootfs}}')" == true ]] || fail "$service root filesystem is writable"
  [[ "$(inspect_value "$service" '{{.HostConfig.Privileged}}')" == false ]] || fail "$service is privileged"
  inspect_value "$service" '{{json .HostConfig.CapDrop}}' | grep -q 'ALL' || fail "$service did not drop all capabilities"
  cap_add="$(inspect_value "$service" '{{json .HostConfig.CapAdd}}')"
  [[ "$cap_add" == null || "$cap_add" == '[]' ]] || fail "$service adds Linux capabilities"
  inspect_value "$service" '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges' || fail "$service allows privilege escalation"
  [[ "$(inspect_value "$service" '{{.HostConfig.RestartPolicy.Name}}')" == "$expected_restart" ]] || fail "$service restart policy is not $expected_restart"
  [[ "$(inspect_value "$service" '{{.HostConfig.PidsLimit}}')" -gt 0 ]] || fail "$service has no process limit"
  [[ "$(inspect_value "$service" '{{.HostConfig.Memory}}')" -gt 0 ]] || fail "$service has no memory limit"
  [[ "$(inspect_value "$service" '{{.HostConfig.NanoCpus}}')" -gt 0 ]] || fail "$service has no CPU limit"
  [[ "$(inspect_value "$service" '{{index .HostConfig.LogConfig.Config "max-size"}}')" == 10m ]] || fail "$service log size is unbounded"
  [[ "$(inspect_value "$service" '{{index .HostConfig.LogConfig.Config "max-file"}}')" == 5 ]] || fail "$service log retention is unbounded"
  if inspect_value "$service" '{{range .Mounts}}{{println .Source " -> " .Destination}}{{end}}' | grep -q 'docker.sock'; then
    fail "$service mounts the container control socket"
  fi
}

assert_mounts() {
  local service="$1"
  local expected_volume="$2"
  shift 2
  local allowed_destinations
  allowed_destinations="$(IFS=,; printf '%s' "$*")"
  node -e "const mounts=JSON.parse(process.argv[1]);const expected=process.argv[2];const allowed=new Set(process.argv[3].split(','));for(const mount of mounts){if(!allowed.has(mount.Destination))process.exit(1);if(mount.Destination.startsWith('/run/secrets/')&&mount.RW)process.exit(1);if(mount.Type==='volume'&&mount.Name!==expected)process.exit(1)}if(expected&&!mounts.some((mount)=>mount.Type==='volume'&&mount.Name===expected))process.exit(1)" \
    "$(inspect_value "$service" '{{json .Mounts}}')" "$expected_volume" "$allowed_destinations" || fail "$service has an unexpected, writable-secret, or anonymous mount"
}

require_command curl
require_command docker
require_command node
require_command openssl

cd "$root"

postgres_password="$(random_secret)"
valkey_password="$(random_secret)"
s3_secret_key="$(random_secret)"
s3_access_key="nexaapp$$"
backup_key="$(random_secret)$(random_secret)"
sensitive_values=(
  "$postgres_password"
  "$valkey_password"
  "$s3_access_key"
  "$s3_secret_key"
  "$backup_key"
)

write_secret postgres_password "$postgres_password"
write_secret database_url "postgresql://nexa:${postgres_password}@postgres:5432/nexa"
write_secret valkey_password "$valkey_password"
write_secret redis_url "redis://default:${valkey_password}@valkey:6379"
write_secret s3_access_key "$s3_access_key"
write_secret s3_secret_key "$s3_secret_key"
write_secret backup_encryption_key "$backup_key"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj "/CN=${public_host}" \
  -addext "subjectAltName=DNS:${public_host}" \
  -keyout "$secret_dir/tls_key.pem" \
  -out "$secret_dir/tls_cert.pem" >/dev/null 2>&1
chmod 0444 "$secret_dir"/*

export NEXA_COMPOSE_PROJECT_NAME="$project"
export NEXA_SECRET_DIR="$secret_dir"
export NEXA_BACKUP_DIR="$scan_dir/backups"
mkdir -m 0700 "$NEXA_BACKUP_DIR"
export NEXA_PUBLIC_ORIGIN="$origin"
export NEXA_HTTPS_BIND_ADDRESS=127.0.0.1
export NEXA_HTTPS_PORT="$port"
export NEXA_FRONTEND_SUBNET="$frontend_subnet"
export NEXA_BACKEND_SUBNET="$backend_subnet"
export NEXA_EDGE_ADDRESS="$edge_address"
export NEXA_SERVER_ADDRESS="$server_address"
export NEXA_IMAGE_SOURCE=https://github.com/cryptnetworks/NexaChat
export NEXA_IMAGE_REVISION="$(git rev-parse HEAD 2>/dev/null || printf local)"
export NEXA_IMAGE_VERSION=verification
export NEXA_IMAGE_TAG="verify-$$"

"${compose[@]}" config --quiet
"${compose[@]}" up --detach --build --wait --wait-timeout 240 || fail 'stack did not become healthy'
"${compose[@]}" run --rm --no-deps migrate || fail 'migration is not repeatable after startup'

for service in postgres valkey object-storage server edge; do
  assert_hardened "$service" unless-stopped
done
assert_hardened migrate no

assert_mounts postgres "${project}_postgres-data" \
  /var/lib/postgresql/data /run/postgresql /tmp /run/secrets/postgres_password
assert_mounts valkey "${project}_valkey-data" \
  /data /run/valkey /tmp /run/secrets/valkey_password
assert_mounts object-storage "${project}_object-storage-data" \
  /data /tmp /run/secrets/s3_access_key /run/secrets/s3_secret_key
assert_mounts migrate '' \
  /tmp /run/secrets/database_url /run/secrets/redis_url \
  /run/secrets/s3_access_key /run/secrets/s3_secret_key
assert_mounts server '' \
  /tmp /run/secrets/database_url /run/secrets/redis_url \
  /run/secrets/s3_access_key /run/secrets/s3_secret_key
assert_mounts edge '' \
  /tmp /run/secrets/tls_cert /run/secrets/tls_key

for service in postgres valkey object-storage migrate server edge; do
  runtime_user="$(inspect_value "$service" '{{.Config.User}}')"
  case "$runtime_user" in
    '' | 0 | 0:* | root | root:*) fail "$service runs as root" ;;
  esac
done

for service in postgres server edge object-storage; do
  [[ "$(inspect_value "$service" '{{index .Config.Labels "org.opencontainers.image.source"}}')" == "$NEXA_IMAGE_SOURCE" ]] || fail "$service image source label is invalid"
  [[ "$(inspect_value "$service" '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$NEXA_IMAGE_REVISION" ]] || fail "$service image revision label is invalid"
  [[ "$(inspect_value "$service" '{{index .Config.Labels "org.opencontainers.image.version"}}')" == "$NEXA_IMAGE_VERSION" ]] || fail "$service image version label is invalid"
done
[[ "$(inspect_value server '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" == GPL-3.0-only ]] || fail 'server image license label is invalid'
[[ "$(inspect_value edge '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" == GPL-3.0-only ]] || fail 'edge image license label is invalid'
[[ "$(inspect_value postgres '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" == PostgreSQL ]] || fail 'PostgreSQL image license label is invalid'
[[ "$(inspect_value object-storage '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" == Apache-2.0 ]] || fail 'object-storage image license label is invalid'

"${compose[@]}" exec -T server node -e "const fs=require('node:fs');const forbidden=['/workspace','/app/server/src','/app/server/test','/app/server/.env','/root/.npm','/home/node/.npm','/usr/local/lib/node_modules/npm','/usr/local/lib/node_modules/corepack','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/local/bin/yarn','/usr/local/bin/yarnpkg','/opt/yarn-v1.22.22','/app/node_modules/typescript','/app/node_modules/vitest','/app/node_modules/eslint','/app/node_modules/prettier','/app/node_modules/esbuild','/app/node_modules/tsx'];for(const path of forbidden)if(fs.existsSync(path))process.exit(1);for(const name of fs.readdirSync('/app/server',{recursive:true}))if(String(name).endsWith('.ts')||String(name).endsWith('.map'))process.exit(1)" || fail 'server image contains source, tests, package managers, development dependencies, or build caches'
"${compose[@]}" exec -T edge /bin/sh -euc "test ! -e /workspace; test ! -e /app; test ! -e /usr/share/nginx/html/.env; test ! -e /root/.npm; if find /usr/share/nginx/html -type f \( -name '*.ts' -o -name '*.map' -o -name '*test*' \) | grep -q .; then exit 1; fi" || fail 'edge image contains source, tests, source maps, or build caches'
"${compose[@]}" exec -T object-storage /bin/sh -euc 'test ! -e /workspace; test ! -e /app; test ! -e /.env; test ! -e /root/.npm' || fail 'object-storage image contains project or build files'
"${compose[@]}" exec -T postgres /bin/sh -euc 'test ! -e /usr/local/bin/gosu' || fail 'PostgreSQL image contains the unused privilege-transition helper'

negative_secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-production-negative-secrets.XXXXXX")"
cp "$secret_dir/database_url" "$secret_dir/s3_access_key" \
  "$secret_dir/s3_secret_key" "$negative_secret_dir/"
mismatched_valkey_password="$(random_secret)"
sensitive_values+=("$mismatched_valkey_password")
write_secret redis_url \
  "redis://default:${mismatched_valkey_password}@valkey:6379" \
  "$negative_secret_dir"
chmod 0444 "$negative_secret_dir"/*
negative_container_name="${project}-valkey-failclosed-$(openssl rand -hex 8)"
negative_server_address="10.231.${network_octet}.4"
negative_container="$(NEXA_SECRET_DIR="$negative_secret_dir" NEXA_SERVER_ADDRESS="$negative_server_address" "${compose[@]}" run --detach --no-deps \
  --name "$negative_container_name" server)" || {
  negative_container=''
  fail 'failed to launch the fail-closed credential probe'
}
[[ "$negative_container" =~ ^[0-9a-f]{12,64}$ ]] || fail 'fail-closed probe returned an invalid container identifier'
negative_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$negative_container")"
negative_oneoff="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$negative_container")"
[[ "$negative_project" == "$project" && "$negative_oneoff" == True ]] || fail 'fail-closed probe container identity is invalid'
negative_status=''
for _ in {1..30}; do
  negative_status="$(docker inspect --format '{{.State.Status}}' "$negative_container" 2>/dev/null || true)"
  [[ "$negative_status" == exited || "$negative_status" == dead ]] && break
  sleep 1
done
[[ "$negative_status" == exited || "$negative_status" == dead ]] || fail 'server accepted invalid Valkey credentials and remained active'
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$negative_container")" -ne 0 ]] || fail 'server accepted invalid Valkey credentials'
negative_logs="$(docker logs "$negative_container" 2>&1 || true)"
grep -q '"event":"startup.failed"' <<< "$negative_logs" || fail 'server did not report a generic fail-closed startup error'
[[ "$negative_logs" != *'service listener active'* && "$negative_logs" != *'"event":"startup.ready"'* ]] || fail 'server opened a listener before rejecting invalid Valkey credentials'
[[ "$negative_logs" != *"$mismatched_valkey_password"* ]] || fail 'fail-closed startup log exposed the invalid credential'
docker rm "$negative_container" >/dev/null || fail 'failed to remove the fail-closed credential probe'
negative_container=''
find "$negative_secret_dir" -type f -delete
rmdir "$negative_secret_dir"
negative_secret_dir=''

[[ -z "$(docker port "$("${compose[@]}" ps -q server)")" ]] || fail 'server publishes a host port'
for service in postgres valkey object-storage; do
  [[ -z "$(docker port "$("${compose[@]}" ps -q "$service")")" ]] || fail "$service publishes a host port"
done
edge_ports="$(docker port "$("${compose[@]}" ps -q edge)")"
[[ "$(wc -l <<< "$edge_ports" | tr -d ' ')" == 1 && "$edge_ports" == "8443/tcp -> 127.0.0.1:${port}" ]] || fail 'edge published an unexpected host port'
[[ "$(docker network inspect --format '{{.Internal}}' "${project}_backend")" == true ]] || fail 'backend network is externally routable'
edge_networks="$(inspect_value edge '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')"
server_networks="$(inspect_value server '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')"
[[ "$edge_networks" == *"${project}_frontend"* && "$edge_networks" != *"${project}_backend"* ]] || fail 'edge network isolation is invalid'
[[ "$server_networks" == *"${project}_frontend"* && "$server_networks" == *"${project}_backend"* ]] || fail 'server network isolation is invalid'
for service in postgres valkey object-storage migrate; do
  service_networks="$(inspect_value "$service" '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')"
  [[ "$service_networks" == *"${project}_backend"* && "$service_networks" != *"${project}_frontend"* ]] || fail "$service is attached outside the backend network"
done
[[ "$(inspect_value server '{{.Config.User}}')" != '' && "$(inspect_value server '{{.Config.User}}')" != 0* ]] || fail 'server runs as root'
[[ "$(inspect_value edge '{{.Config.User}}')" != '' && "$(inspect_value edge '{{.Config.User}}')" != 0* ]] || fail 'edge runs as root'

server_environment="$(inspect_value server '{{range .Config.Env}}{{println .}}{{end}}')"
if grep -Eq '^(DATABASE_URL|REDIS_URL|S3_ACCESS_KEY|S3_SECRET_KEY)=' <<< "$server_environment"; then
  fail 'server credentials were injected through inspectable environment values'
fi

curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  --dump-header "$headers_file" "$origin/health/live" | grep -qx '{"status":"ok"}' || fail 'liveness response is invalid'
grep -qi '^strict-transport-security: max-age=31536000' "$headers_file" || fail 'HSTS is missing'
grep -qi '^content-security-policy:' "$headers_file" || fail 'content security policy is missing'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  "$origin/health/startup" | grep -qx '{"status":"started"}' || fail 'startup response is invalid'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  "$origin/health/ready" | grep -qx '{"status":"ready"}' || fail 'readiness response is invalid'
metrics_status="$(curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --silent --output /dev/null --write-out '%{http_code}' --cacert "$secret_dir/tls_cert.pem" "$origin/metrics")"
[[ "$metrics_status" == 404 ]] || fail 'metrics are exposed through the public edge'
oversized_status="$(node -e "process.stdout.write('x'.repeat(16385))" | curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --silent --output /dev/null --write-out '%{http_code}' --cacert "$secret_dir/tls_cert.pem" --header 'Content-Type: application/octet-stream' --data-binary @- "$origin/v1/auth/login")"
[[ "$oversized_status" == 413 ]] || fail 'edge did not enforce the shared request-body bound'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" "$origin/" | grep -q '<div id="root"' || fail 'static application is unavailable'

username="verify$$"
password="Verify-$(random_secret)"
sensitive_values+=("$password")
printf '{"username":"%s","displayName":"Production verification","password":"%s"}' "$username" "$password" | \
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  --cookie-jar "$cookie_jar" \
  --header 'Content-Type: application/json' \
  --header "Origin: $origin" \
  --data-binary @- \
  "$origin/v1/auth/register" | grep -q "\"username\":\"${username}\"" || fail 'HTTPS registration failed'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  --cookie "$cookie_jar" "$origin/v1/account" | grep -q "\"username\":\"${username}\"" || fail 'authenticated HTTPS request failed'
session_cookie="$(awk '$6 == "__Host-nexa_session" { print $6 "=" $7 }' "$cookie_jar" | tail -n 1)"
[[ -n "$session_cookie" ]] || fail 'secure session cookie was not issued'
sensitive_values+=("${session_cookie#*=}")
NEXA_VERIFY_WS_URL="wss://${public_host}:${port}/v1/realtime" \
NEXA_VERIFY_ORIGIN="$origin" \
NEXA_VERIFY_COOKIE="$session_cookie" \
NEXA_VERIFY_CA_FILE="$secret_dir/tls_cert.pem" \
  node scripts/verify-production-websocket.mjs || fail 'authenticated WebSocket upgrade or heartbeat failed'

object_key="verification/object-$$"
"${compose[@]}" exec -T -e NEXA_VERIFY_OBJECT_KEY="$object_key" server node --input-type=module -e \
  "import fs from 'node:fs'; import {GetObjectCommand,PutObjectCommand,S3Client} from '@aws-sdk/client-s3'; const client=new S3Client({endpoint:'http://object-storage:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretAccessKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()}}); await client.send(new PutObjectCommand({Bucket:'nexa-attachments',Key:process.env.NEXA_VERIFY_OBJECT_KEY,Body:'durable-object'})); const result=await client.send(new GetObjectCommand({Bucket:'nexa-attachments',Key:process.env.NEXA_VERIFY_OBJECT_KEY})); if(await result.Body.transformToString()!=='durable-object') process.exit(1); const unsigned=await fetch('http://object-storage:8333/nexa-attachments?list-type=2'); if(unsigned.status!==403) process.exit(1)" || fail 'authenticated object operation or anonymous-access denial failed'

"${compose[@]}" stop --timeout 30 object-storage
"${compose[@]}" up --detach --wait --wait-timeout 120 object-storage || fail 'object storage did not recover after graceful restart'
"${compose[@]}" exec -T -e NEXA_VERIFY_OBJECT_KEY="$object_key" server node --input-type=module -e \
  "import fs from 'node:fs'; import {DeleteObjectCommand,GetObjectCommand,S3Client} from '@aws-sdk/client-s3'; const client=new S3Client({endpoint:'http://object-storage:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretAccessKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()}}); const result=await client.send(new GetObjectCommand({Bucket:'nexa-attachments',Key:process.env.NEXA_VERIFY_OBJECT_KEY})); if(await result.Body.transformToString()!=='durable-object') process.exit(1); await client.send(new DeleteObjectCommand({Bucket:'nexa-attachments',Key:process.env.NEXA_VERIFY_OBJECT_KEY}))" || fail 'object did not survive object-storage restart'

"${compose[@]}" exec -T server node -e "const fs=require('node:fs');let denied=false;try{fs.writeFileSync('/app/.nexa-write-test','x')}catch(error){denied=error.code==='EROFS'||error.code==='EACCES'}if(!denied)process.exit(1);fs.writeFileSync('/tmp/nexa-write-test','x');fs.unlinkSync('/tmp/nexa-write-test')" || fail 'server root filesystem restriction failed'

shutdown_started="$SECONDS"
"${compose[@]}" stop --timeout 20 server
shutdown_elapsed=$(( SECONDS - shutdown_started ))
[[ "$shutdown_elapsed" -le 20 ]] || fail 'server exceeded its graceful stop deadline'
[[ "$(inspect_value server '{{.State.ExitCode}}')" == 0 ]] || fail 'server did not exit cleanly on SIGTERM'
server_logs="$("${compose[@]}" logs --no-color server)"
grep -q '"event":"shutdown.signal"' <<< "$server_logs" || fail 'shutdown signal was not logged'
grep -q '"event":"shutdown.completed"' <<< "$server_logs" || fail 'bounded shutdown completion was not logged'

privacy_marker="private-marker-$$"
sensitive_values+=("$privacy_marker")
upstream_status="$(curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --silent --output /dev/null --write-out '%{http_code}' --cacert "$secret_dir/tls_cert.pem" "$origin/v1/unavailable?marker=${privacy_marker}")"
[[ "$upstream_status" == 502 || "$upstream_status" == 504 ]] || fail 'edge did not report the stopped upstream as unavailable'
edge_logs="$("${compose[@]}" logs --no-color edge)"
[[ "$edge_logs" != *"$privacy_marker"* ]] || fail 'edge error log exposed a request URI'
[[ "$edge_logs" != *'127.0.0.1'* ]] || fail 'edge logs exposed a client address'

"${compose[@]}" up --detach --wait --wait-timeout 120 server edge || fail 'stack did not recover after graceful restart'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" "$origin/health/live" >/dev/null || fail 'edge did not recover after server restart'
curl --noproxy '*' --resolve "${public_host}:${port}:127.0.0.1" --fail --silent --show-error --cacert "$secret_dir/tls_cert.pem" \
  --cookie "$cookie_jar" "$origin/v1/account" | grep -q "\"username\":\"${username}\"" || fail 'durable account or session did not survive restart'

if [[ "${NEXA_VERIFY_SCAN:-0}" == 1 ]]; then
  "${compose[@]}" --profile operations build backup || fail 'backup operations image build failed'
  bash scripts/scan-production-images.sh "$scan_dir/sbom" \
    "${NEXA_SERVER_IMAGE:-nexa-chat-server}:${NEXA_IMAGE_TAG}" \
    "${NEXA_EDGE_IMAGE:-nexa-chat-edge}:${NEXA_IMAGE_TAG}" \
    "${NEXA_OBJECT_STORAGE_IMAGE:-nexa-chat-object-storage}:${NEXA_IMAGE_TAG}" \
    "${NEXA_POSTGRES_IMAGE:-nexa-chat-postgres}:${NEXA_IMAGE_TAG}" \
    "${NEXA_BACKUP_IMAGE:-nexa-chat-backup}:${NEXA_IMAGE_TAG}" \
    'valkey/valkey:8.1.9-alpine3.24@sha256:a038175878d66b9d274fbf8be73c0305e93798b83917647f167e18cef3c71eec' || fail 'production image scan or SBOM validation failed'
fi

"${compose[@]}" logs --no-color > "$logs_file"
logs="$(< "$logs_file")"
for value in "${sensitive_values[@]}"; do
  [[ "$logs" != *"$value"* ]] || fail 'sensitive value appeared in production logs'
done

echo 'Production HTTPS, authenticated HTTP/WebSocket, isolation, hardening, health, and graceful shutdown verified.'
