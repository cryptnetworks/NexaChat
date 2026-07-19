# Nexa Chat

Nexa Chat is an early-stage, self-hosted communication platform for persistent communities. The development vertical slice uses PostgreSQL for accounts, communities, memberships, categories, spaces, messages, and session records.

Local account registration and login use Argon2id password hashes and revocable PostgreSQL sessions. Browser sessions use HTTP-only, SameSite=Strict cookies. WebSocket upgrades use the same revocable session, require the exact trusted browser origin, and revalidate access throughout each connection.

## Prerequisites

- Node.js 24.18.0 (pinned in `.node-version`, `.nvmrc`, and `.tool-versions`)
- npm 11.16.0 (pinned by `packageManager`)
- Docker Engine with Docker Compose, for PostgreSQL and local adapter services

Rust desktop prerequisites are not currently satisfied on the verified development machine. See [Desktop status](#desktop-status).

## Local setup

From the repository root:

```sh
npm run dev:up
```

The command verifies the pinned toolchain, installs exactly the lockfile,
creates `.env` only when absent, waits for all Compose dependencies, and starts
the API and web processes. It never replaces an existing `.env` or volume.

Open `http://localhost:5173`. The API listens on `http://localhost:3000`; Vite proxies `/v1`, `/health`, and WebSocket traffic to it. Server startup applies forward-only PostgreSQL migrations before accepting traffic. To apply them separately, run `npm run migrate`.

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
npm test
npm run build --workspace @nexa/server
npm run build --workspace @nexa/web
docker compose config --quiet
npm audit
npm run verify:clean-env
```

`npm test` runs the complete test suite. `npm run test:postgres` requires the Compose PostgreSQL service and exercises repositories, constraints, transactions, migrations, readiness, and persistence across API restarts.

`npm run verify:clean-env` uses the isolated `nexa-chat-clean-verify` Compose project and PostgreSQL port 55432, then removes only that project's test volume. It verifies an empty database migration, readiness, dependency outage, and automatic recovery.

## Architecture

- `apps/server` is the Fastify HTTP and WebSocket process.
- `apps/web` is the React/Vite browser client.
- `packages/api-contracts` owns shared HTTP request/response schemas and WebSocket client/server control-message schemas. Zod validates untrusted boundary input at runtime.
- `packages/auth` owns local authentication behavior, password hashing, token protection, expiration, and replaceable rate-limiting ports.
- `packages/authorization` owns the versioned permission catalog, deny-by-default scoped evaluator, ownership and protected-role rules, and the shared preview/enforcement path.
- `packages/realtime-contracts` owns versioned server event envelopes and reuses message response schemas from `api-contracts`.
- `packages/domain` contains storage ports, the community service, authorization rules, and an in-memory test adapter without transport-specific logic.
- `packages/postgres` implements the storage ports, connection pooling, schema verification, and concurrency-safe migrations.

Malformed HTTP input returns a stable `invalid_request` response with a correlation ID and no validation internals. Malformed WebSocket messages return `invalid_message`; missing and unauthorized subscription targets both return the non-disclosing `unavailable` error.

Every HTTP response includes `X-Request-Id` and `X-API-Version: 1`. Errors use a versioned envelope with a stable code, correlation ID, and explicit retryability. Rate limits include `Retry-After`; bodies, timeouts, cursors, page sizes, and the instance address-bucket set are bounded. See [HTTP API contracts](docs/architecture/api-contracts.md).

WebSocket control messages are versioned and support subscribe, unsubscribe, and heartbeat operations. Connections, subscriptions, command rates, frames, and outbound buffering are bounded. Session and permission checks run throughout active connections; heartbeats remove stale clients; shutdown drains sockets. Event deliveries include per-process, per-space sequence numbers and globally unique event IDs. Clients deduplicate IDs, detect sequence gaps, and reconcile durable history over HTTP after gaps or jittered reconnects.

Authentication endpoints are `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `GET /v1/account`, and `GET /v1/sessions`. State-changing requests require the configured exact `Origin`; cookie-authenticated logout requests also require `X-Nexa-CSRF: 1`. Authentication failures return stable `authentication_failed`, `unauthenticated`, `identifier_unavailable`, `rate_limited`, or `csrf_rejected` codes without account-existence details.

Runtime configuration is parsed exactly once before database initialization or socket binding. Development values are listed in `.env.example`; production requires an explicit PostgreSQL URL and exact HTTPS web origin, forces secure cookies, rejects development identity, and fails startup with the stable `invalid_configuration` diagnostic. Diagnostics name the invalid key but never include its value.

Community lifecycle endpoints support authenticated community, membership, category, and text-space operations. Names are normalized and scoped for active uniqueness. Collections use bounded stable cursors, version fields reject stale writes, and archival preserves message history. Cookie-authenticated mutations require the exact configured `Origin` and `X-Nexa-CSRF: 1`.

Community invitations are bounded, revocable, optionally account-targeted, and stored only as protected token hashes. Authorized administrators can create, list, and revoke invitations. Authenticated preview and acceptance use privacy-safe failures, rate limits, atomic usage claims, idempotent active-membership handling, and audit events. Browser invite tokens are consumed from URL fragments and removed from history before preview.

## Desktop status

The web/domain split is suitable for a thin Tauri shell without duplicating interface or domain logic, but the desktop scaffold is deferred because `rustc`, `cargo`, and the Tauri CLI are not installed locally. Xcode 26.6 is available.

Before adding `apps/desktop`, install the stable Rust toolchain (including `rustc` and `cargo`) using the official Rust installer, ensure the macOS Xcode command-line tools are selected, and make the Tauri CLI available as a repository-local development dependency. The future desktop package should load or build `apps/web` and expose root-level desktop development and build commands.

## Current limitations

- PostgreSQL persistence and a private S3-compatible object-storage adapter are implemented. Attachment application flows and Valkey are not connected.
- Real-time sequences are intentionally process-local and are gap signals, not durable replay cursors; HTTP history remains authoritative after reconnects and server restarts.
- The web client provides keyboard-accessible community/category/space navigation and loading, empty, and error states; lifecycle administration forms are not yet exposed.
- There is no desktop application scaffold until the documented toolchain is available.
- External identity providers, account recovery, multi-factor authentication, voice, video, federation, and peer-to-peer transport are planned work, not implemented behavior.

Further context is in the [architecture record](docs/architecture/0001-application-language.md), [operations guide](docs/operations/development.md), [security policy](SECURITY.md), and [roadmap](ROADMAP.md).

## License

Copyright © 2026 cryptnetworks.

NexaChat is licensed under GPL-3.0-only. See [LICENSE](LICENSE) for the
complete license terms and [NOTICE](NOTICE) for attribution.
