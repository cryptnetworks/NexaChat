#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="nexa-chat-backup-verify-$$"
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-backup-secrets.XXXXXX")"
backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/nexa-chat-backups.XXXXXX")"
logs_file="$(mktemp "${TMPDIR:-/tmp}/nexa-chat-backup-logs.XXXXXX")"
compose=(docker compose -f compose.production.yml -p "$project" --profile operations)
started_at="$(date +%s)"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  find "$secret_dir" -type f -delete 2>/dev/null || true
  rmdir "$secret_dir" 2>/dev/null || true
  find "$backup_dir" -depth -delete 2>/dev/null || true
  rm -f "$logs_file"
}
trap cleanup EXIT INT TERM

fail() {
  echo "backup_restore_verification_error: $*" >&2
  exit 1
}

write_secret() {
  (umask 077 && printf '%s\n' "$2" > "$secret_dir/$1")
}

expect_rejection() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "unsafe case unexpectedly succeeded: $expected"
  fi
  printf '%s\n' "$output" >> "$logs_file"
  grep -q "\"code\":\"$expected\"" <<<"$output" || fail "unsafe case did not report $expected"
}

run_logged() {
  local status
  set +e
  "$@" 2>&1 | tee -a "$logs_file"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

assert_backup_hardened() {
  "${compose[@]}" create backup >/dev/null
  local container
  container="$("${compose[@]}" ps --all --quiet backup)"
  [[ -n "$container" ]] || fail 'backup operations container was not created'
  [[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")" == true ]] || fail 'backup root filesystem is writable'
  [[ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$container")" == false ]] || fail 'backup container is privileged'
  docker inspect --format '{{json .HostConfig.CapDrop}}' "$container" | grep -q ALL || fail 'backup container did not drop all capabilities'
  docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container" | grep -q no-new-privileges || fail 'backup container permits privilege escalation'
  [[ "$(docker inspect --format '{{.Config.User}}' "$container")" != 0 ]] || fail 'backup container runs as root'
  [[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container")" == no ]] || fail 'backup operations container can restart unattended'
  [[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" -gt 0 ]] || fail 'backup process count is unbounded'
  [[ "$(docker inspect --format '{{.HostConfig.Memory}}' "$container")" -gt 0 ]] || fail 'backup memory is unbounded'
  [[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container")" -gt 0 ]] || fail 'backup CPU is unbounded'
  [[ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container")" == '{}' ]] || fail 'backup container publishes a port'
  if docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | grep -q docker.sock; then
    fail 'backup container can control Docker'
  fi
  "${compose[@]}" rm --force backup >/dev/null
}

cd "$root"
for command in docker node openssl; do
  command -v "$command" >/dev/null || fail "$command is required"
done

postgres_password="$(openssl rand -hex 24)"
s3_secret_key="$(openssl rand -hex 24)"
s3_access_key="nexabackup$$"
backup_key="$(openssl rand -hex 32)"
valkey_password="$(openssl rand -hex 24)"
write_secret postgres_password "$postgres_password"
write_secret database_url "postgresql://nexa:${postgres_password}@postgres:5432/nexa"
write_secret valkey_password "$valkey_password"
write_secret redis_url "redis://default:${valkey_password}@valkey:6379"
write_secret s3_access_key "$s3_access_key"
write_secret s3_secret_key "$s3_secret_key"
write_secret backup_encryption_key "$backup_key"
write_secret tls_cert.pem unused-verification-certificate
write_secret tls_key.pem unused-verification-key
chmod 0444 "$secret_dir"/*
chmod 0700 "$backup_dir"

export NEXA_COMPOSE_PROJECT_NAME="$project"
export NEXA_SECRET_DIR="$secret_dir"
export NEXA_BACKUP_DIR="$backup_dir"
export NEXA_BACKUP_UID="$(id -u)"
export NEXA_BACKUP_GID="$(id -g)"
export NEXA_PUBLIC_ORIGIN=https://backup.example.test
export NEXA_IMAGE_SOURCE=https://github.com/cryptnetworks/NexaChat
export NEXA_IMAGE_REVISION="$(git rev-parse HEAD 2>/dev/null || printf local)"
export NEXA_IMAGE_VERSION=backup-verification
export NEXA_IMAGE_TAG="backup-verify-$$"
export NEXA_FRONTEND_SUBNET="10.233.$((16 + ($$ % 200))).0/28"
export NEXA_BACKEND_SUBNET="10.234.$((16 + ($$ % 200))).0/28"
export NEXA_EDGE_ADDRESS="${NEXA_FRONTEND_SUBNET%0/28}2"
export NEXA_SERVER_ADDRESS="${NEXA_FRONTEND_SUBNET%0/28}3"

"${compose[@]}" config --quiet
"${compose[@]}" up --detach --build --wait --wait-timeout 240 postgres valkey object-storage
assert_backup_hardened
"${compose[@]}" run --rm migrate

"${compose[@]}" exec -T postgres psql --username nexa --dbname nexa --set ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO accounts (id, display_name, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Backup Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-000000000002', 'Backup Member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO communities (id, owner_id, name)
VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Backup Community');
INSERT INTO memberships (id, community_id, account_id, status, created_at, updated_at)
VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO categories (id, community_id, name, position)
VALUES ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Backup Category', 0);
INSERT INTO spaces (id, community_id, category_id, name, kind, position)
VALUES ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Backup Space', 'text', 0);
INSERT INTO messages (id, space_id, author_id, body, created_at, idempotency_key)
VALUES ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'restore verification message', CURRENT_TIMESTAMP, 'backup-restore-verification');
INSERT INTO invitations
  (id, community_id, creator_id, token_hash, created_at, expires_at, max_uses)
VALUES
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001', repeat('a', 64), CURRENT_TIMESTAMP,
   CURRENT_TIMESTAMP + interval '1 day', 1);
INSERT INTO audit_events
  (id, event_version, actor_type, actor_id, community_id, scope_type, scope_id,
   target_type, target_id, invitation_id, action, outcome, reason_code,
   correlation_id, occurred_at, retention_until)
VALUES
  ('70000000-0000-4000-8000-000000000001', 1, 'account',
   '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'community', '10000000-0000-4000-8000-000000000001', 'invitation',
   '60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
   'invitation.create', 'succeeded', NULL, '80000000-0000-4000-8000-000000000001',
   '2026-01-01T00:00:00.000Z', '2033-01-01T00:00:00.000Z');
INSERT INTO audit_checkpoints
  (id, community_id, chain_index, head_hash, actor_type, actor_id,
   correlation_id, created_at)
SELECT '90000000-0000-4000-8000-000000000001', community_id, chain_index,
       event_hash, 'account', '00000000-0000-4000-8000-000000000001',
       '80000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP
FROM audit_events WHERE id = '70000000-0000-4000-8000-000000000001';
SQL

"${compose[@]}" run --rm --no-deps --entrypoint node backup -e '
const fs=require("node:fs");
const {S3Client,PutObjectCommand}=require("@aws-sdk/client-s3");
const read=(path)=>fs.readFileSync(path,"utf8").trim();
const client=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,forcePathStyle:true,credentials:{accessKeyId:read(process.env.S3_ACCESS_KEY_FILE),secretAccessKey:read(process.env.S3_SECRET_KEY_FILE)}});
client.send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:"verification/object-one",Body:Buffer.from("verified object bytes"),ContentType:"application/octet-stream",Metadata:{"nexa-sha256":"232198c5f3bf85c90d6bc909ac6a815a3b1a1cec8c62738a4e282165cf37bf50","verification-state":"ready"},Tagging:"lifecycle=active"})).finally(()=>client.destroy());
'

export NEXA_BACKUP_MODE=quiesced
run_logged "${compose[@]}" run --rm backup backup
unset NEXA_BACKUP_MODE
backup_path="$(find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' | head -n 1)"
[[ -n "$backup_path" ]] || fail 'completed backup was not created'
backup_name="$(basename "$backup_path")"
run_logged "${compose[@]}" run --rm backup verify "/backups/$backup_name"

mkdir "$backup_dir/.partial-controlled"
expect_rejection incomplete_backup "${compose[@]}" run --rm backup verify /backups/.partial-controlled

cp -R "$backup_path" "$backup_dir/backup-corrupt-controlled"
printf '\001' | dd of="$backup_dir/backup-corrupt-controlled/postgres.dump.enc" bs=1 seek=64 conv=notrunc 2>/dev/null
expect_rejection component_integrity_mismatch "${compose[@]}" run --rm backup verify /backups/backup-corrupt-controlled

cp -R "$backup_path" "$backup_dir/backup-missing-controlled"
find "$backup_dir/backup-missing-controlled" -name objects.archive.enc -type f -delete
expect_rejection component_missing "${compose[@]}" run --rm backup verify /backups/backup-missing-controlled

original_key="$backup_key"
chmod 0600 "$secret_dir/backup_encryption_key"
write_secret backup_encryption_key "$(openssl rand -hex 32)"
chmod 0444 "$secret_dir/backup_encryption_key"
expect_rejection manifest_authentication_failed "${compose[@]}" run --rm backup verify "/backups/$backup_name"
chmod 0600 "$secret_dir/backup_encryption_key"
write_secret backup_encryption_key "$original_key"
chmod 0444 "$secret_dir/backup_encryption_key"

find "$backup_dir/backup-corrupt-controlled" -depth -delete
find "$backup_dir/backup-missing-controlled" -depth -delete
cp -R "$backup_path" "$backup_dir/backup-old-controlled"
touch -t 202001010000 "$backup_dir/backup-old-controlled"
touch -t 202001010000 "$backup_dir/.partial-controlled"
export NEXA_BACKUP_RETENTION_COUNT=1
export NEXA_BACKUP_RETENTION_DAYS=0
export NEXA_BACKUP_INCOMPLETE_HOURS=1
run_logged "${compose[@]}" run --rm backup prune
unset NEXA_BACKUP_RETENTION_COUNT NEXA_BACKUP_RETENTION_DAYS NEXA_BACKUP_INCOMPLETE_HOURS
[[ ! -e "$backup_dir/backup-old-controlled" ]] || fail 'expired completed backup was not pruned'
[[ ! -e "$backup_dir/.partial-controlled" ]] || fail 'expired incomplete backup was not pruned'
[[ -d "$backup_path" ]] || fail 'newest verified backup was pruned'

"${compose[@]}" down --volumes --remove-orphans
"${compose[@]}" up --detach --build --wait --wait-timeout 240 postgres object-storage
export NEXA_RECOVERY_MODE=empty-only
run_logged "${compose[@]}" run --rm backup restore "/backups/$backup_name"
unset NEXA_RECOVERY_MODE
"${compose[@]}" run --rm migrate
expect_rejection restore_requires_recovery_mode "${compose[@]}" run --rm backup restore "/backups/$backup_name"

database_match="$("${compose[@]}" exec -T postgres psql --username nexa --dbname nexa --tuples-only --no-align --command "SELECT (SELECT count(*) FROM accounts) = 2 AND (SELECT count(*) FROM communities) = 1 AND (SELECT count(*) FROM memberships) = 2 AND (SELECT count(*) FROM spaces) = 1 AND (SELECT count(*) FROM messages WHERE body = 'restore verification message') = 1;")"
[[ "$database_match" == t ]] || fail 'representative PostgreSQL data did not match'

audit_query="SELECT (SELECT count(*) FROM audit_events) = 1
  AND (SELECT count(*) FROM audit_checkpoints) = 1
  AND (SELECT bool_and(previous_hash = repeat('0', 64)
    AND event_hash = encode(digest(concat_ws('|', previous_hash,
      event_version::text, id::text, actor_type,
      COALESCE(actor_id::text, service_id, ''), scope_type,
      COALESCE(scope_id::text, ''), target_type, COALESCE(target_id::text, ''),
      action, outcome, COALESCE(reason_code, ''), correlation_id::text,
      to_char(retention_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
    ), 'sha256'), 'hex')) FROM audit_events)
  AND (SELECT bool_and(c.chain_index=e.chain_index AND c.head_hash=e.event_hash)
    FROM audit_checkpoints c JOIN audit_events e
      ON e.community_id=c.community_id AND e.chain_index=c.chain_index);"
audit_match="$("${compose[@]}" exec -T postgres psql --username nexa --dbname nexa --tuples-only --no-align --command "$audit_query")"
[[ "$audit_match" == t ]] || fail 'restored audit chain or checkpoint did not verify'

"${compose[@]}" run --rm --no-deps --entrypoint node backup -e '
const fs=require("node:fs");
const {S3Client,GetObjectCommand,GetObjectTaggingCommand}=require("@aws-sdk/client-s3");
const read=(path)=>fs.readFileSync(path,"utf8").trim();
const client=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,forcePathStyle:true,credentials:{accessKeyId:read(process.env.S3_ACCESS_KEY_FILE),secretAccessKey:read(process.env.S3_SECRET_KEY_FILE)}});
(async()=>{const object=await client.send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:"verification/object-one"}));const body=Buffer.from(await object.Body.transformToByteArray());const tags=await client.send(new GetObjectTaggingCommand({Bucket:process.env.S3_BUCKET,Key:"verification/object-one"}));if(body.toString()!=="verified object bytes"||object.ContentType!=="application/octet-stream"||object.Metadata["verification-state"]!=="ready"||tags.TagSet[0]?.Key!=="lifecycle"||tags.TagSet[0]?.Value!=="active")process.exitCode=1;})().finally(()=>client.destroy());
'

elapsed="$(( $(date +%s) - started_at ))"
if [[ -n "${NEXA_BACKUP_EVIDENCE_FILE:-}" ]]; then
  printf '{"status":"passed","schemaVersion":7,"accounts":2,"communities":1,"memberships":2,"spaces":1,"messages":1,"auditEvents":1,"auditCheckpoints":1,"objects":1,"elapsedSeconds":%s}\n' "$elapsed" > "$NEXA_BACKUP_EVIDENCE_FILE"
fi
for value in "$postgres_password" "$s3_secret_key" "$s3_access_key" "$backup_key" "$valkey_password"; do
  if grep -Fq "$value" "$logs_file"; then fail 'sensitive value appeared in verification logs'; fi
done
echo "Encrypted backup, rejection controls, isolated restore, migration compatibility, audit integrity/checkpoint, PostgreSQL data, object bytes, metadata, and tags verified in ${elapsed}s."
