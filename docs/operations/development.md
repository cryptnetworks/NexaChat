# Development and operations

## Reproducible startup

Node 24.18.0 is pinned for nvm, asdf/mise, and tools that consume
`.node-version`; npm 11.16.0 is pinned in `package.json`. Run `npm run dev:up`
from the repository root. It rejects a mismatched Node/npm version with a stable
`toolchain_error`, preserves an existing `.env`, installs the exact lockfile,
waits for pinned Compose services to become healthy, and then runs both
development processes in the foreground. Stop the processes with Ctrl-C;
`docker compose down` stops services without deleting data.

## Local services

Copy `.env.example` to `.env`, change local secrets if the machine is shared, and run `docker compose up -d`. PostgreSQL is authoritative durable data, Valkey is ephemeral coordination with local persistence enabled, and SeaweedFS is S3-compatible attachment storage. The application currently uses PostgreSQL; the other services remain adapter targets.

Run `npm ci` and `npm run dev`. `/health/live` reports process liveness,
`/health/startup` reports completed initialization, and `/health/ready` returns
`200` only when PostgreSQL is reachable and its schema matches this build.
Enabled optional Valkey or object-storage failures report degraded readiness
without taking authoritative PostgreSQL flows offline. `/metrics` is for an
internal monitoring network only. See the [observability guide](observability.md)
for probe semantics, telemetry privacy, alerts, and local smoke checks.

For a destructive clean smoke test, run `npm run verify:clean-env`. Each run uses
a uniquely named `nexa-chat-clean-verify-*` Compose project, per-run API and
provider ports, a private temporary log, and project-scoped PostgreSQL, Valkey,
and SeaweedFS volumes. The bounded cleanup trap removes only those disposable
resources. The script verifies the toolchain, lockfile install, Compose
configuration, empty-database migration, generic health and metrics,
PostgreSQL-required outage/recovery, optional Valkey and object-storage
degradation/recovery, telemetry privacy, and bounded SIGTERM shutdown. Do not
point this test at shared or production providers.

## Troubleshooting

- `toolchain_error`: activate Node 24.18.0 with the repository's version-manager
  file and install npm 11.16.0; do not bypass the check.
- A published-port conflict: stop the process using 5432/6379/8333, or set
  `POSTGRES_PUBLISHED_PORT`, `VALKEY_PUBLISHED_PORT`,
  `S3_PUBLISHED_PORT` before startup
  and update matching application URLs in `.env`.
- A service never becomes healthy: run `docker compose ps` and bounded
  `docker compose logs --tail=100 <service>`; logs must not be pasted publicly
  without checking for credentials or private content.
- `invalid_configuration`: compare key names with `.env.example`; the diagnostic
  deliberately omits the rejected value.
- PostgreSQL outage: `/health/live` remains live while `/health/ready` returns 503. Restore PostgreSQL and readiness recovers without restarting the API.
- Corrupt local disposable data: back up anything needed, then explicitly run
  `docker compose down --volumes`; this permanently deletes local service data.

If `npm ci` or image pulls fail because a registry is unavailable, stop and
retry after recovery. Do not switch registries, relax integrity, use `npm
install`, or replace pinned image digests as an outage workaround.

## Runtime configuration

The server reads the environment once at process startup and passes typed configuration into database, authentication, HTTP, and WebSocket composition. Unknown `NEXA_*` keys are rejected so misspellings and removed settings cannot silently weaken behavior. Required values are `DATABASE_URL` and `NEXA_WEB_ORIGIN`. Production additionally requires an exact HTTPS origin, secure cookies, and development identity disabled. Startup reports `invalid_configuration` with the affected key and a safe reason before opening a database connection or listening; configured values are never echoed.

`.env.example` is the development inventory. It includes bounded server body
size, request and shutdown timeouts; structured log level and trace sample rate;
PostgreSQL pool and connection/query timeouts; session lifetimes and rate limits;
and Argon2id cost parameters. Values at documented bounds are accepted and
values outside them fail startup. There are no implicit authoritative-work retry
queues: startup fails after the bounded PostgreSQL connection timeout, while an
already-running process exposes required dependency loss through
`/health/ready` and automatically reports ready again after PostgreSQL recovers.

For production, supply secrets through the deployment secret manager rather than committing an environment file. Rotate database credentials by creating a replacement credential, updating instances, confirming readiness, then revoking the old credential. If rotation fails, restore the prior secret while it remains valid. Recovery after an outage requires no configuration mutation; readiness is rechecked on every probe. Configuration rollback means restoring the previously reviewed key set and restarting. Retain a database backup before migrations as described below.

## Local authentication

Usernames are normalized with Unicode NFKC and locale-independent lowercase behavior, then uniquely constrained in PostgreSQL. Passwords are 12–128 characters and are hashed with Argon2id. `NEXA_ARGON2_MEMORY_KIB`, `NEXA_ARGON2_PASSES`, `NEXA_ARGON2_PARALLELISM`, `NEXA_ARGON2_TAG_LENGTH`, and `NEXA_ARGON2_SALT_LENGTH` are bounded and validated at startup. Encoded hashes retain their parameters so a successful login can safely rehash when settings increase.

Sessions use 256-bit opaque tokens; only SHA-256 representations are stored. Absolute and idle lifetimes are controlled by `NEXA_SESSION_ABSOLUTE_SECONDS` and `NEXA_SESSION_IDLE_SECONDS`. Production always emits `Secure; HttpOnly; SameSite=Strict; Path=/` on the `__Host-nexa_session` cookie. Local HTTP development sets `NEXA_SECURE_COOKIES=false` and uses the unprefixed `nexa_session` cookie; never use that setting in production. Changing credentials increments `credential_version`, which immediately invalidates older sessions. Recent authentication time is retained for future sensitive-operation gates.

Authentication attempts are bounded independently by normalized identifier and source using a replaceable in-process limiter. A limiter failure rejects authentication deterministically. Cross-instance distributed enforcement remains separate work; deployments with multiple API replicas must provide the future shared limiter before claiming a global limit.

The former `/v1/dev/accounts` route is absent from the application route graph. Setting obsolete development environment variables cannot restore it. Passwords, raw tokens, cookies, and authorization headers are redacted or excluded from structured logs.

## Migrations and rollback

Database migrations are forward-only, reviewed SQL in `apps/server/migrations`. Run `npm run migrate` from the repository root to migrate an empty or existing compatible database. Startup runs the same migrations under a PostgreSQL advisory lock, records names and SHA-256 checksums in `nexa_schema_migrations`, and refuses missing or altered history.

Create the next migration with a zero-padded sequential prefix and descriptive lowercase name, for example `0002_add_invites.sql`. Never edit an applied migration. Review each migration for deterministic SQL, constraints and indexes, lock duration, data-loss risk, and compatibility with the currently deployed application before merging it.

Releases must back up before migration. Rollback means deploying the prior schema-compatible application; an applied migration is never automatically reversed. Destructive schema cleanup belongs in a later reviewed migration after the compatibility window.

The pool defaults to 10 connections with explicit connection, idle, and query timeouts. Adjust the bounded `NEXA_DATABASE_*` values in the environment when deployment capacity requires it. Timestamps are stored as `timestamptz` and sessions store only SHA-256 token hashes, never raw session tokens.

Authorization schema changes are forward-only. Roles use optimistic versions, scoped decisions and assignments use idempotent unique keys, and sensitive mutations run in serializable transactions. A serialization or version conflict is a deterministic stale write and callers must reload current state before retrying. Ownership transfer is atomic and requires the successor to be an active community member.

## Backup and restore

A production backup must consistently cover PostgreSQL and object storage, encrypt data, record software/schema versions, and be restore-tested. Valkey is reconstructible and is not authoritative. No backup command is claimed until durable storage is implemented.

## Production baseline

Run containers as non-root with read-only filesystems where possible, terminate TLS at a maintained proxy, restrict service ports to a private network, rotate secrets, set explicit quotas, collect OpenTelemetry logs/metrics/traces without message content, and handle `SIGTERM` gracefully. Kubernetes is not required.

The initial Compose file is for development services only. Release images, migration automation, signing, scanning, and an update procedure remain planned production work.
