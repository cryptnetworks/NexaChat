# Development and operations

## Local services

Copy `.env.example` to `.env`, change local secrets if the machine is shared, and run `docker compose up -d`. PostgreSQL is authoritative durable data, Valkey is ephemeral coordination with local persistence enabled, and MinIO is S3-compatible attachment storage. The application currently uses PostgreSQL; the other services remain adapter targets.

Run `npm ci` and `npm run dev`. `/health/live` reports process liveness. `/health/ready` returns `200` only when PostgreSQL is reachable and its schema matches this build; otherwise it returns `503` without exposing connection details.

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

## Backup and restore

A production backup must consistently cover PostgreSQL and object storage, encrypt data, record software/schema versions, and be restore-tested. Valkey is reconstructible and is not authoritative. No backup command is claimed until durable storage is implemented.

## Production baseline

Run containers as non-root with read-only filesystems where possible, terminate TLS at a maintained proxy, restrict service ports to a private network, rotate secrets, set explicit quotas, collect OpenTelemetry logs/metrics/traces without message content, and handle `SIGTERM` gracefully. Kubernetes is not required.

The initial Compose file is for development services only. Release images, migration automation, signing, scanning, and an update procedure remain planned production work.
