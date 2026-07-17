# Development and operations

## Local services

Copy `.env.example` to `.env`, change local secrets if the machine is shared, and run `docker compose up -d`. PostgreSQL is durable data, Valkey is ephemeral coordination with local persistence enabled, and MinIO is S3-compatible attachment storage. The current slice uses none of them yet; they establish adapter targets.

Run `npm ci` and `npm run dev`. Never enable development authentication in production. `/health/live` reports process liveness; `/health/ready` will report dependency readiness when durable adapters exist.

## Migrations and rollback

Database migrations will be forward-only, reviewed SQL with an application compatibility window. Releases must back up before migration. Rollback means deploying the prior compatible application; destructive schema cleanup occurs only in later releases. Migration tooling is unresolved until the first schema is introduced.

## Backup and restore

A production backup must consistently cover PostgreSQL and object storage, encrypt data, record software/schema versions, and be restore-tested. Valkey is reconstructible and is not authoritative. No backup command is claimed until durable storage is implemented.

## Production baseline

Run containers as non-root with read-only filesystems where possible, terminate TLS at a maintained proxy, restrict service ports to a private network, rotate secrets, set explicit quotas, collect OpenTelemetry logs/metrics/traces without message content, and handle `SIGTERM` gracefully. Kubernetes is not required.

The initial Compose file is for development services only. Release images, migration automation, signing, scanning, and an update procedure remain planned production work.
