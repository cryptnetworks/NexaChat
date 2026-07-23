# Nexa Chat

Nexa Chat is an early-stage, self-hosted communication platform for persistent communities. The development vertical slice uses PostgreSQL for accounts, communities, memberships, categories, spaces, messages, and session records.

Local account registration and login use Argon2id password hashes and revocable PostgreSQL sessions. Browser sessions use HTTP-only, SameSite=Strict cookies. WebSocket upgrades use the same revocable session, require the exact trusted browser origin, and revalidate access throughout each connection.

## Prerequisites

- Node.js 24.18.0 (pinned in `.node-version`, `.nvmrc`, and `.tool-versions`)
- npm 11.16.0 (pinned by `packageManager`)
- Rust 1.97.1 (pinned by `rust-toolchain.toml`) for desktop development
- Docker Engine with Docker Compose, for PostgreSQL and local adapter services

Desktop packaging also requires the target platform prerequisites described in
the [desktop architecture guide](docs/architecture/desktop.md). Supported and
unsupported browser, desktop, server, dependency, and protocol combinations are
defined by the [support and compatibility policy](docs/releases/support-compatibility.md).

## Local setup

From the repository root:

```sh
npm run dev:up
```

The command verifies the pinned toolchain, installs exactly the lockfile,
creates `.env` only when absent, waits for all Compose dependencies, and starts
the API and web processes. It never replaces an existing `.env` or volume.

Open `http://localhost:5173`. The API listens on `http://localhost:3000`; Vite proxies `/v1`, `/health`, and WebSocket traffic to it. Server startup applies forward-only PostgreSQL migrations before accepting traffic. To apply them separately, run `npm run migrate`. The API exposes separate liveness, startup, and readiness probes plus internal Prometheus-compatible metrics; see the [observability guide](docs/operations/observability.md).

To run the API and web client in hardened development containers instead of
host Node processes, use `npm run dev:containers`. This opt-in profile keeps
provider ports private, publishes application ports to loopback only, and
preserves PostgreSQL and object-storage volumes across application restarts.
See the [application container guide](docs/operations/container-applications.md)
for targets, configuration, platform scope, and destructive-cleanup warnings.

## Verification

Every project command runs from the repository root:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:http
npm run test:websocket
npm run test:postgres
npm run test:auth
npm run test:authorization
npm run test:config
npm run test:architecture
npm run test:contracts
npm run verify:security-policy
npm run verify:container-policy
npm run test:e2e
npm run test:performance
npm run test:realtime-capacity
npm run test:resilience
npm run test:desktop
npm test
npm run build --workspace @nexa/server
npm run build --workspace @nexa/web
npm run desktop:build
docker compose config --quiet
npm audit
npm run verify:clean-env
```

`npm test` runs the complete test suite. `npm run test:postgres` requires the Compose PostgreSQL service and exercises repositories, constraints, transactions, migrations, readiness, and persistence across API restarts. The bounded API benchmark and its disposable-PostgreSQL release profile are documented in the [performance runbook](docs/operations/performance.md). Connection, fan-out, reconnect, slow-consumer, Valkey, and soak workloads are documented in the [real-time capacity runbook](docs/operations/realtime-capacity.md). Immutable storage retries, worker leases, checkpoints, and injected recovery failures are documented in the [failure-recovery runbook](docs/operations/failure-recovery.md).

Pull requests also run immutable dependency review, full-history and proposed-tree secret scanning, pinned static analysis, license/migration/workflow checks, validated CycloneDX output, and a disposable encrypted backup/restore cycle. Scheduled default-branch verification adds production image scans and BuildKit provenance validation. See the [supply-chain security guide](docs/operations/supply-chain-security.md) for trust boundaries, thresholds, triage, suppressions, and local reproduction, and the [backup and restore runbook](docs/operations/backup-and-restore.md) for recovery.

`npm run verify:clean-env` uses a uniquely named `nexa-chat-clean-verify-*`
Compose project and per-run API, PostgreSQL, Valkey, and SeaweedFS ports, then
removes only that project's containers, network, and volumes. It verifies empty-database
migration, generic health semantics, metrics, required and optional dependency
outage/recovery, private-value exclusion, and bounded shutdown.

`npm run test:e2e` starts a uniquely named disposable PostgreSQL Compose project,
migrates it from zero, runs the API and Vite proxy on per-run loopback ports,
and verifies registration, authenticated profile access, and logout in Chromium.
It runs with one worker, keeps no Playwright trace, video, screenshot, or server
log artifact, and removes its containers, volume, processes, and temporary
files on completion.

## Production deployment

The hardened single-host profile builds pinned, non-root server and HTTPS edge
images, publishes only the edge, keeps providers on an internal network, injects
credentials as file-backed secrets, gates startup on private-bucket creation and
forward-only migration, and bounds runtime resources and shutdown. Follow the
[application container guide](docs/operations/container-applications.md) and
[production deployment runbook](docs/operations/production-deployment.md) before
using `compose.production.yml`; the development Compose file is not a production
configuration.

Use the isolated end-to-end check before an installation or upgrade:

```sh
bash scripts/verify-production.sh
```

An optional, pinned Cloudflare Tunnel overlay removes the host edge port and
uses two hardened outbound connectors with a file-backed token and verified
origin TLS. Follow the [Cloudflare Tunnel runbook](docs/operations/cloudflare-tunnel.md)
and run `npm run verify:cloudflare-tunnel`; the verification uses only synthetic
local credentials and never creates a real tunnel.

## Architecture

- `apps/server` is the Fastify HTTP and WebSocket process.
- `apps/web` is the React/Vite browser client.
- `packages/api-contracts` owns shared HTTP request/response schemas and WebSocket client/server control-message schemas. Zod validates untrusted boundary input at runtime.
- `packages/auth` owns local authentication behavior, password hashing, token protection, expiration, and replaceable rate-limiting ports.
- `packages/authorization` owns the versioned permission catalog, deny-by-default scoped evaluator, ownership and protected-role rules, and the shared preview/enforcement path.
- `packages/realtime-contracts` owns versioned server event envelopes and reuses message response schemas from `api-contracts`.
- `packages/domain` contains storage ports, the community service, authorization rules, and an in-memory test adapter without transport-specific logic.
- `packages/postgres` implements the storage ports, connection pooling, schema verification, and concurrency-safe migrations.
- [Data lifecycle and retention model](docs/privacy/data-lifecycle.md) defines policy precedence, export and deletion handling, legal holds, backup recovery, and operator responsibilities.

Malformed HTTP input returns a stable `invalid_request` response with a correlation ID and no validation internals. Malformed WebSocket messages return `invalid_message`; missing and unauthorized subscription targets both return the non-disclosing `unavailable` error.

Every HTTP response includes `X-Request-Id` and `X-API-Version: 1`. Errors use a versioned envelope with a stable code, correlation ID, and explicit retryability. Rate limits include `Retry-After`; bodies, timeouts, cursors, page sizes, and the instance address-bucket set are bounded. See [HTTP API contracts](docs/architecture/api-contracts.md).

WebSocket control messages are versioned and support subscribe, unsubscribe, and heartbeat operations. Connections, subscriptions, command rates, frames, and outbound buffering are bounded. Session and permission checks run throughout active connections; heartbeats remove stale clients; shutdown drains sockets. Event deliveries include per-process, per-space sequence numbers and globally unique event IDs. Clients deduplicate IDs, detect sequence gaps, and reconcile durable history over HTTP after gaps or jittered reconnects.

Authentication endpoints are `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `GET /v1/account`, and `GET /v1/sessions`. State-changing requests require the configured exact `Origin`; cookie-authenticated logout requests also require `X-Nexa-CSRF: 1`. Authentication failures return stable `authentication_failed`, `unauthenticated`, `identifier_unavailable`, `rate_limited`, or `csrf_rejected` codes without account-existence details.

Runtime configuration is parsed exactly once before database initialization or socket binding. Development values are listed in `.env.example`; production requires an explicit PostgreSQL URL and exact HTTPS web origin, forces secure cookies, rejects development identity, and fails startup with the stable `invalid_configuration` diagnostic. Diagnostics name the invalid key but never include its value.

Community lifecycle endpoints support authenticated community, membership, category, and text-space operations. Names are normalized and scoped for active uniqueness. Collections use bounded stable cursors, version fields reject stale writes, and archival preserves message history. Cookie-authenticated mutations require the exact configured `Origin` and `X-Nexa-CSRF: 1`.

Community invitations are bounded, revocable, optionally account-targeted, and stored only as protected token hashes. Authorized administrators can create, list, and revoke invitations. Authenticated preview and acceptance use privacy-safe failures, rate limits, atomic usage claims, idempotent active-membership handling, and audit events. Browser invite tokens are consumed from URL fragments and removed from history before preview.

## Desktop status

`apps/desktop` is a thin Tauri 2 shell that builds and loads `apps/web`. The
Rust toolchain and repository-local Tauri CLI are pinned, native capabilities
are explicit, and the shell exposes no application IPC commands or shell
execution. Use `npm run desktop:dev` for development, `npm run desktop:build`
for a native executable, and `npm run desktop:package` only on a host prepared
to package the target platform. See the
[desktop architecture guide](docs/architecture/desktop.md) for the verified
platform scope and trust boundary.

## Current limitations

- PostgreSQL persistence, a private S3-compatible object-storage adapter, and a resilient Valkey coordination adapter are implemented. Attachment and coordination application flows are not connected.
- Real-time sequences are intentionally process-local and are gap signals, not durable replay cursors; HTTP history remains authoritative after reconnects and server restarts.
- The web client provides keyboard-accessible community/category/space navigation and loading, empty, and error states; lifecycle administration forms are not yet exposed.
- Desktop navigation, protected credentials, and privacy-preserving native
  notification adapters are implemented and locally tested. Production
  signing/notarization, a protected update service, and retained validation on
  every supported platform are not complete, so no production desktop release
  is claimed.
- External identity providers, account recovery, multi-factor authentication, voice, video, federation, and peer-to-peer transport are planned work, not implemented behavior.

Further context is in the [architecture record](docs/architecture/0001-application-language.md), [operations guide](docs/operations/development.md), [observability guide](docs/operations/observability.md), [security policy](SECURITY.md), [security threat model](docs/security/threat-model.md), [2026 security audit](docs/security/audit-2026-07-22.md), and [roadmap](ROADMAP.md).

## License

Copyright © 2026 cryptnetworks.

NexaChat is licensed under GPL-3.0-only. See [LICENSE](LICENSE) for the
complete license terms and [NOTICE](NOTICE) for attribution.
