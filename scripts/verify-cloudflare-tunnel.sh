#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-cloudflare-verify-$$"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-cloudflare-secrets.XXXXXX")"
logs_file="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-cloudflare-logs.XXXXXX")"
probe_secret="probe-$(openssl rand -hex 18)"
network_octet=$(( 16 + ($$ % 200) ))
frontend_subnet="10.232.${network_octet}.0/28"
backend_subnet="10.232.${network_octet}.16/28"
edge_address="10.232.${network_octet}.2"
server_address="10.232.${network_octet}.3"
public_host=chat.example.test
compose=(docker compose -f compose.production.yml -f compose.cloudflare-tunnel.yml --profile cloudflare -p "$project")

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  find "$secret_dir" -type f -delete 2>/dev/null || true
  rmdir "$secret_dir" 2>/dev/null || true
  rm -f "$logs_file"
}
trap cleanup EXIT INT TERM

fail() {
  echo "cloudflare_verification_error: $*" >&2
  "${compose[@]}" ps >&2 || true
  "${compose[@]}" logs --no-color --tail 120 2>/dev/null | sed "s/${probe_secret}/[REDACTED]/g" >&2 || true
  exit 1
}

write_secret() {
  local name="$1"
  local value="$2"
  (umask 077 && printf '%s\n' "$value" > "$secret_dir/$name")
}

inspect_value() {
  local service="$1"
  local template="$2"
  local container
  container="$("${compose[@]}" ps --all --quiet "$service")"
  [[ -n "$container" ]] || fail "$service container is missing"
  docker inspect --format "$template" "$container"
}

assert_connector() {
  local service="$1"
  [[ "$(inspect_value "$service" '{{.Config.User}}')" == 65532:65532 ]] || fail "$service user is not fixed non-root"
  [[ "$(inspect_value "$service" '{{.HostConfig.ReadonlyRootfs}}')" == true ]] || fail "$service root filesystem is writable"
  [[ "$(inspect_value "$service" '{{.HostConfig.Privileged}}')" == false ]] || fail "$service is privileged"
  inspect_value "$service" '{{json .HostConfig.CapDrop}}' | grep -q ALL || fail "$service did not drop all capabilities"
  inspect_value "$service" '{{json .HostConfig.SecurityOpt}}' | grep -q no-new-privileges || fail "$service permits privilege escalation"
  [[ "$(inspect_value "$service" '{{.HostConfig.RestartPolicy.Name}}')" == unless-stopped ]] || fail "$service restart policy is invalid"
  [[ "$(inspect_value "$service" '{{.HostConfig.PidsLimit}}')" -gt 0 ]] || fail "$service pids are unbounded"
  [[ "$(inspect_value "$service" '{{.HostConfig.Memory}}')" -gt 0 ]] || fail "$service memory is unbounded"
  [[ "$(inspect_value "$service" '{{.HostConfig.NanoCpus}}')" -gt 0 ]] || fail "$service CPU is unbounded"
  [[ -z "$(docker port "$("${compose[@]}" ps --all --quiet "$service")")" ]] || fail "$service publishes a host port"
  inspect_value "$service" '{{json .Config.Cmd}}' | grep -q -- '--token-file' || fail "$service does not use a token file"
  inspect_value "$service" '{{json .Mounts}}' | grep -q '/run/secrets/cloudflare_tunnel_token' || fail "$service token secret is not mounted"
  inspect_value "$service" '{{json .Mounts}}' | grep -q '/run/secrets/tunnel_origin_ca' || fail "$service origin CA is not mounted"
  if inspect_value "$service" '{{range .Config.Env}}{{println .}}{{end}}' | grep -Eq '(^|_)TOKEN='; then
    fail "$service exposes a token through its environment"
  fi
  [[ "$(inspect_value "$service" '{{.Config.Image}}')" == *'@sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d' ]] || fail "$service image is not immutable"
}

cd "$root"
for command in docker node openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

write_secret postgres_password "$(openssl rand -hex 24)"
postgres_password="$(cat "$secret_dir/postgres_password")"
write_secret database_url "postgresql://nexa:${postgres_password}@postgres:5432/nexa"
write_secret valkey_password "$(openssl rand -hex 24)"
valkey_password="$(cat "$secret_dir/valkey_password")"
write_secret redis_url "redis://default:${valkey_password}@valkey:6379"
write_secret s3_access_key "nexaprobe$$"
write_secret s3_secret_key "$(openssl rand -hex 24)"
write_secret backup_encryption_key "$(openssl rand -hex 48)"
write_secret cloudflare_tunnel_token "synthetic-local-token-not-valid"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj '/CN=NexaChat tunnel verification CA' \
  -keyout "$secret_dir/tunnel_origin_ca.key" \
  -out "$secret_dir/tunnel_origin_ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -subj "/CN=${public_host}" \
  -keyout "$secret_dir/tls_key.pem" \
  -out "$secret_dir/tls.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$public_host" > "$secret_dir/tls.ext"
openssl x509 -req -sha256 -days 1 \
  -in "$secret_dir/tls.csr" \
  -CA "$secret_dir/tunnel_origin_ca.pem" \
  -CAkey "$secret_dir/tunnel_origin_ca.key" \
  -CAcreateserial \
  -extfile "$secret_dir/tls.ext" \
  -out "$secret_dir/tls_cert.pem" >/dev/null 2>&1
find "$secret_dir" -type f \( -name '*.key' -o -name '*.csr' -o -name '*.ext' -o -name '*.srl' \) -delete
chmod 0444 "$secret_dir"/*

export NEXA_COMPOSE_PROJECT_NAME="$project"
export NEXA_SECRET_DIR="$secret_dir"
export NEXA_BACKUP_DIR="$secret_dir/backups"
mkdir -m 0700 "$NEXA_BACKUP_DIR"
export NEXA_PUBLIC_ORIGIN="https://${public_host}"
export NEXA_FRONTEND_SUBNET="$frontend_subnet"
export NEXA_BACKEND_SUBNET="$backend_subnet"
export NEXA_EDGE_ADDRESS="$edge_address"
export NEXA_SERVER_ADDRESS="$server_address"
export NEXA_IMAGE_REVISION="$(git rev-parse HEAD 2>/dev/null || printf local)"
export NEXA_IMAGE_VERSION=cloudflare-verification
export NEXA_IMAGE_TAG="cloudflare-verify-$$"

npm run verify:cloudflare-policy >/dev/null
"${compose[@]}" config --quiet
"${compose[@]}" up --detach --build --wait --wait-timeout 240 \
  postgres valkey object-storage migrate server edge || fail 'private origin stack did not become healthy'

[[ -z "$(docker port "$("${compose[@]}" ps -q edge)")" ]] || fail 'edge publishes a host port'
for service in postgres valkey object-storage server; do
  [[ -z "$(docker port "$("${compose[@]}" ps -q "$service")")" ]] || fail "$service publishes a host port"
done
[[ "$(docker network inspect --format '{{.Internal}}' "${project}_backend")" == true ]] || fail 'backend is externally routable'

probe_image="nexa-chat-server:${NEXA_IMAGE_TAG}"
probe_common=(
  --rm
  --network "${project}_tunnel"
  --volume "$secret_dir/tunnel_origin_ca.pem:/tmp/tunnel_origin_ca.pem:ro"
  --volume "$root/scripts/verify-cloudflare-probe.mjs:/tmp/verify-cloudflare-probe.mjs:ro"
  --env "NEXA_PROBE_HOST=$public_host"
  --env NEXA_PROBE_ADDRESS=edge
  --env "NEXA_PROBE_SECRET=$probe_secret"
  --env "NEXA_PROBE_SUFFIX=$$"
  --entrypoint node
  "$probe_image"
  /tmp/verify-cloudflare-probe.mjs
)
docker run --ip 172.29.0.2 "${probe_common[@]}" || fail 'trusted connector routing probe failed'
NEXA_PROBE_MODE=spoof docker run --ip 172.29.0.5 --env NEXA_PROBE_MODE=spoof "${probe_common[@]}" || fail 'spoofed connector probe was accepted'

"${compose[@]}" create cloudflared-a cloudflared-b >/dev/null
assert_connector cloudflared-a
assert_connector cloudflared-b

connector_a_networks="$(inspect_value cloudflared-a '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')"
edge_networks="$(inspect_value edge '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')"
[[ "$connector_a_networks" == *"${project}_tunnel"* && "$connector_a_networks" != *"${project}_frontend"* && "$connector_a_networks" != *"${project}_backend"* ]] || fail 'connector network isolation is invalid'
[[ "$edge_networks" == *"${project}_tunnel"* && "$edge_networks" == *"${project}_frontend"* && "$edge_networks" != *"${project}_backend"* ]] || fail 'edge tunnel isolation is invalid'

"${compose[@]}" logs --no-color > "$logs_file"
for value in "$probe_secret" "$postgres_password" "$valkey_password" synthetic-local-token-not-valid; do
  if grep -Fq "$value" "$logs_file"; then
    fail 'a verification credential appeared in production logs'
  fi
done
if grep -Eqi 'cookie:|authorization:|cf-access-jwt-assertion:|set-cookie:' "$logs_file"; then
  fail 'a sensitive HTTP header appeared in production logs'
fi

echo 'Cloudflare Tunnel private-origin routing, proxy trust, hardening, secrets, cookies, origins, Access non-bypass, and log safety verified.'
