# Single-host production deployment

The supported encrypted data-protection and recovery procedure is documented
in [Encrypted backup and restore](backup-and-restore.md). Do not enable public
traffic until a disposable restore has passed for the deployed revision.

This profile runs NexaChat on one Docker host behind a non-root HTTPS edge. It
is suitable for a small self-hosted installation with one failure domain. It is
not a high-availability design: host, disk, or bridge-network failure can make
the entire service unavailable.

## Security boundary

Only the edge publishes a host port. The server is reachable only on the
isolated frontend network, and PostgreSQL, Valkey, and object storage are
reachable only on an internal backend network with no host route. The edge
overwrites forwarded-address headers, and the server trusts only the edge's
fixed `/32` address.

```text
clients -> host TCP 443 -> edge:8443 -> server:3000 -> internal dependencies
```

The `single-host-private` application profile permits plaintext Valkey and S3
traffic only to the exact `valkey:6379` and `object-storage:8333` service names.
That exception is safe only while the backend remains an internal, single-host
network. Standard production mode continues to require TLS for remote Valkey
and object-storage endpoints. PostgreSQL is likewise restricted to the exact
private service name in this profile. Do not attach unrelated containers to
either production network.

Every long-running service has a read-only root filesystem, drops all Linux
capabilities, prevents privilege escalation, bounds processes/CPU/memory/open
files, rotates local logs, and has an explicit healthcheck and stop deadline.
Every long-running and one-shot service runs non-root. The pinned SeaweedFS
4.40 runtime replaces only its `weed` binary with a reproducible build from
upstream revision `875cd1f67ea25e8965a4f5ba1e6aaf501ba6b6fa`; that build pins
gRPC-Go 1.82.1 to include the current upstream security fixes. The runtime owns
`/data` before Docker initializes the named volume, reads its
bucket-scoped S3 identity from files, and creates the configured private bucket
as part of startup. No provider administrator identity or root permission job is
needed on a clean host.

## Host prerequisites

- A dedicated, patched Linux host with Docker Engine and the Compose plugin.
- At least 4 GiB of memory, 2 CPU cores, and sufficient durable disk space for
  three named volumes plus backups.
- A public DNS name resolving to the host.
- A trusted certificate whose subject alternative names include that DNS name.
- Host firewall rules that admit the configured HTTPS port and administrative
  access only. Do not expose ports 3000, 5432, 6379, or 8333.
- `curl`, OpenSSL, Node.js 24, and npm dependencies when running the complete
  local verification script.

Review `deploy/production.env.example`, copy it to a root-owned file outside
the repository, and select frontend/backend subnets that do not overlap host,
VPN, or site routes. `NEXA_EDGE_ADDRESS` and `NEXA_SERVER_ADDRESS` must be
distinct usable addresses in `NEXA_FRONTEND_SUBNET`. The trusted proxy `/32` is
derived directly from `NEXA_EDGE_ADDRESS` by the Compose profile. Keeping both
frontend endpoints static prevents startup order from changing the trusted proxy
identity.

## Secrets

Create a host directory owned by the deployment administrator with mode
`0700`. These exact files are required:

| File                        | Consumer                       | Contents                                                   |
| --------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `postgres_password`         | PostgreSQL bootstrap only      | URL-safe random password for the initial `nexa` owner      |
| `database_owner_url`        | `database-bootstrap` only      | `postgresql://nexa:PASSWORD@postgres:5432/nexa`            |
| `database_migrator_password`| `database-bootstrap` only      | URL-safe password for `nexa_migrator`                      |
| `migration_database_url`    | migration job and restore job  | `postgresql://nexa_migrator:PASSWORD@postgres:5432/nexa`   |
| `database_runtime_password` | `database-bootstrap` only      | URL-safe password for `nexa_app`                           |
| `runtime_database_url`      | server only                    | `postgresql://nexa_app:PASSWORD@postgres:5432/nexa`        |
| `database_backup_password`  | `database-bootstrap` only      | URL-safe password for `nexa_backup`                        |
| `backup_database_url`       | backup job only                | `postgresql://nexa_backup:PASSWORD@postgres:5432/nexa`     |
| `valkey_password`           | Valkey                         | URL-safe random password                                   |
| `redis_url`                 | migration job and server       | `redis://default:PASSWORD@valkey:6379`                     |
| `s3_access_key`             | SeaweedFS and application      | URL-safe bucket-scoped application access key              |
| `s3_secret_key`             | SeaweedFS and application      | URL-safe bucket-scoped application secret                  |
| `tls_cert.pem`              | edge                           | full certificate chain in PEM form                         |
| `tls_key.pem`               | edge                           | matching unencrypted private key in PEM form               |

Generate independent credentials. This example deliberately limits generated
characters to the unambiguous URL-safe set used by startup validation:

```sh
sudo install -d -m 0700 /etc/nexa-chat/secrets
sudo sh -c '
  set -eu
  directory=/etc/nexa-chat/secrets
  umask 077
  postgres_password=$(openssl rand -hex 32)
  migration_password=$(openssl rand -hex 32)
  runtime_password=$(openssl rand -hex 32)
  backup_password=$(openssl rand -hex 32)
  valkey_password=$(openssl rand -hex 32)
  printf "%s\n" "$postgres_password" > "$directory/postgres_password"
  printf "postgresql://nexa:%s@postgres:5432/nexa\n" "$postgres_password" > "$directory/database_owner_url"
  printf "%s\n" "$migration_password" > "$directory/database_migrator_password"
  printf "postgresql://nexa_migrator:%s@postgres:5432/nexa\n" "$migration_password" > "$directory/migration_database_url"
  printf "%s\n" "$runtime_password" > "$directory/database_runtime_password"
  printf "postgresql://nexa_app:%s@postgres:5432/nexa\n" "$runtime_password" > "$directory/runtime_database_url"
  printf "%s\n" "$backup_password" > "$directory/database_backup_password"
  printf "postgresql://nexa_backup:%s@postgres:5432/nexa\n" "$backup_password" > "$directory/backup_database_url"
  printf "%s\n" "$valkey_password" > "$directory/valkey_password"
  printf "redis://default:%s@valkey:6379\n" "$valkey_password" > "$directory/redis_url"
  printf "nexaapp%s\n" "$(openssl rand -hex 8)" > "$directory/s3_access_key"
  openssl rand -hex 32 > "$directory/s3_secret_key"
  unset postgres_password migration_password runtime_password backup_password valkey_password
'
sudo install -m 0444 /path/to/fullchain.pem /etc/nexa-chat/secrets/tls_cert.pem
sudo install -m 0444 /path/to/private-key.pem /etc/nexa-chat/secrets/tls_key.pem
sudo chmod 0444 /etc/nexa-chat/secrets/*
```

Compose file-backed secrets are bind mounts and cannot remap UID/GID/mode. The
source files therefore need read-only mode `0444` so the isolated non-root
containers can read only the files mounted into them. The enclosing host
directory's `0700` mode prevents other host users from traversing to those
files. Never place secrets in the environment file, command line, image, or
repository.

SeaweedFS reads the application identity files on every start, builds a private
configuration in its bounded `/tmp`, and restricts that identity to read, list,
tag, and write operations on only `NEXA_S3_BUCKET`. Startup validates the bucket
name and credentials before opening the service. Keep the two identity files
host-restricted and maintain a separately recoverable copy; they are required
for restart, restore, and deliberate credential rotation.

## First deployment

Use an explicit environment file on every command. Render and inspect the model
before creating anything:

```sh
docker compose --env-file /etc/nexa-chat/production.env \
  -f compose.production.yml config --quiet
docker compose --env-file /etc/nexa-chat/production.env \
  -f compose.production.yml config
```

The rendered environment must contain only `_FILE` references for database,
Valkey, and S3 credentials. It must show one published edge port and no published
server or provider ports.

Build the four pinned custom runtime targets and start the stack; Valkey is the
additional pinned provider image:

```sh
docker compose --env-file /etc/nexa-chat/production.env \
  -f compose.production.yml build --pull
docker compose --env-file /etc/nexa-chat/production.env \
  -f compose.production.yml up --detach --wait --wait-timeout 240
```

Startup fails closed. SeaweedFS validates its file-backed identity and creates
the private bucket before becoming healthy; object storage must be healthy
before migration; and migration must finish before the server. Migrations use
the PostgreSQL advisory lock and
transactional history/checksum validation, so two operators cannot apply a
migration concurrently. An interrupted migration rolls its transaction back;
investigate and rerun `up` rather than editing migration history.

The expected health bodies are generic:

```sh
curl --fail --silent --show-error https://chat.example.com/health/live
curl --fail --silent --show-error https://chat.example.com/health/startup
curl --fail --silent --show-error https://chat.example.com/health/ready
```

They return `{"status":"ok"}`, `{"status":"started"}`, and normally
`{"status":"ready"}`. Readiness returns `503` when PostgreSQL or migration
state is unavailable, and `200` with `degraded` when an optional dependency is
temporarily unavailable. Liveness must not be used as a traffic-readiness gate.
The edge returns `404` for `/metrics`; scrape metrics only from the server on the
private frontend network. See `docs/operations/observability.md` for probe and
alert semantics.

## Verification and image scanning

The destructive verification helper creates a unique temporary Compose project,
certificate, credentials, networks, images, and volumes. It verifies clean
startup, private bucket access and persistence, HTTPS/security headers, an authenticated
HTTP request, an authenticated WSS heartbeat, non-root/read-only runtime state,
port and network isolation, resource/log limits, secret absence from inspectable
environment and logs, fail-closed startup with a deliberately mismatched Valkey
credential, SIGTERM shutdown, and durable account/session recovery.
It removes only its own temporary project and data:

```sh
bash scripts/verify-production.sh
```

Set `NEXA_VERIFY_SCAN=1` to also save each image to a private temporary archive,
scan every fixed and unfixed HIGH/CRITICAL finding in the application, edge,
object-storage, PostgreSQL, and Valkey images with the
immutable scanner pin, generate a CycloneDX image SBOM for each image, and
validate every SBOM before cleanup. CI retains both the CycloneDX SBOM and the
structured vulnerability JSON for every scanned image:

```sh
NEXA_VERIFY_SCAN=1 bash scripts/verify-production.sh
```

Do not replace the immutable scanner digest with a mutable tag. Review the
upstream signature, release provenance, and digest before updating the pin.

## Routine operation

Use `docker compose ... ps` for container/health state and
`docker compose ... logs --since 15m server edge` for bounded, structured
diagnostics. Avoid debug logging in production. Logs must never contain
credentials, session cookies, message contents, attachment keys, or provider
error payloads. Nginx emits only emergency startup/configuration diagnostics and
a safe access record containing method, status, byte count, and duration;
request URI/query and client address are deliberately excluded. Keep host log
collection retention at or below the limits in the observability guide.

The application handles `SIGTERM` by making readiness unavailable, rejecting
new application work, draining WebSockets and admitted HTTP work, and closing
dependencies within 15 seconds. Compose allows 20 seconds before forcing the
server. Stop it with:

```sh
docker compose --env-file /etc/nexa-chat/production.env \
  -f compose.production.yml stop --timeout 20 server
```

Do not use `kill -9` except when the bounded shutdown has already failed. Edge
uses `SIGQUIT` for graceful worker shutdown; PostgreSQL and migration receive a
longer 60-second deadline.

### Upgrades and rollback

1. Confirm a recent, separately stored restore test for every durable volume.
2. Review dependency/image changes and the release's forward-only migrations.
3. Set immutable image/revision/version values in the host environment file.
4. Run the complete verification and image scan against the exact candidate.
5. Run `build --pull`, then `up --detach --wait`.
6. Confirm readiness, authenticated HTTP/WSS, dashboards, and bounded logs.

Never run `down --volumes` against a real project. Database migrations are
forward-only. Rolling an image back is safe only when the older application is
documented compatible with the current schema. Otherwise restore the coordinated
pre-upgrade backup into a new isolated project, validate it, and switch traffic.
Do not manually delete migration history or partially restore one provider.

### Certificate and credential rotation

Replace certificate files atomically, validate their key/chain and SANs, then
recreate only the edge. For application credentials, plan a maintenance window:
stop edge/server, rotate the provider identity and matching secret file, rerun
the relevant provider/migration validation, recreate server/edge, and verify an
authenticated durable request. Rotate one dependency at a time.

`POSTGRES_PASSWORD_FILE` initializes only a new volume; changing that file does
not change the existing `nexa` owner. The owner URL is mounted only by the
one-shot role bootstrap job. That job transfers application-schema ownership to
`nexa_migrator`, grants the server role data access without DDL or migration
history writes, and grants the backup role read access only. It is safe to rerun
after a controlled credential rotation.

Rotate one database role at a time. Stop the consumers of that role, generate a
replacement password, atomically replace its password file and matching URL,
run `database-bootstrap`, then restart and verify only the relevant consumer:
`migrate` for `nexa_migrator`, server plus a durable request for `nexa_app`, or
the encrypted backup verification for `nexa_backup`. Restore the previous pair
while it remains valid if the verification fails. Keep the owner credentials
restricted to recovery and role administration; do not mount them into the
server, migration, backup, or restore jobs. For Valkey, stop writers,
atomically replace both `valkey_password` and `redis_url`, recreate Valkey and
server, verify, and retain the old pair until completion. Never print values
while comparing or rotating them.

## Recovery and troubleshooting

- `migrate` failure: keep the server stopped, inspect only structured migration
  events, verify `migration_database_url`, the role-bootstrap completion, and
  migration checksums, then rerun. Do not bypass the completion dependency.
- object-storage startup failure: verify the bucket name and both S3 identity
  files. The identity is intentionally limited to the configured bucket.
- edge unhealthy: validate the certificate/key pair and permissions, then use
  `docker compose ... exec edge nginx -t` without copying secrets out.
- readiness unavailable with liveness healthy: inspect PostgreSQL and migration
  first, then optional-provider health. Do not restart-loop a live process before
  finding the unavailable dependency.
- address-pool conflict: choose two unused private CIDRs and keep the edge address
  plus trusted `/32` consistent.
- resource exhaustion: use aggregate process/container telemetry to identify the
  constrained service; change reviewed limits explicitly rather than removing
  bounds.

The edge and server both enforce the reviewed 16,384-byte API body limit; the
edge rejects oversized bodies before buffering them. A future upload API must
change both `client_max_body_size` and `NEXA_SERVER_BODY_LIMIT_BYTES` in one
reviewed change, with a separately bounded streaming design.

Named volumes are the authoritative local state. Maintain encrypted, off-host,
retention-bounded backups and perform scheduled restores into an isolated
project. A backup is not trusted until the restored PostgreSQL schema/history,
private object bucket, and application health are verified together.
