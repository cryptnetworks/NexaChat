# Nexa Chat

Nexa Chat is an early-stage, self-hosted communication platform for persistent communities. The development vertical slice uses PostgreSQL for accounts, communities, memberships, categories, spaces, messages, and session records.

The development identity flow is not production authentication. HTTP account creation and WebSocket subscriptions are available only when both `NODE_ENV=development` and `NEXA_ENABLE_DEV_AUTH=true`. The server has no production authentication or authorization mechanism.

## Prerequisites

- Node.js 24.x
- npm 11.x
- Docker Engine with Docker Compose, for PostgreSQL and local adapter services

Rust desktop prerequisites are not currently satisfied on the verified development machine. See [Desktop status](#desktop-status).

## Local setup

From the repository root:

```sh
npm ci
cp .env.example .env
docker compose up -d
npm run dev
```

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
npm test
npm run build --workspace @nexa/server
npm run build --workspace @nexa/web
docker compose config --quiet
npm audit
```

`npm test` runs the complete test suite. `npm run test:postgres` requires the Compose PostgreSQL service and exercises repositories, constraints, transactions, migrations, readiness, and persistence across API restarts.

## Architecture

- `apps/server` is the Fastify HTTP and WebSocket process.
- `apps/web` is the React/Vite browser client.
- `packages/api-contracts` owns shared HTTP request/response schemas and WebSocket client/server control-message schemas. Zod validates untrusted boundary input at runtime.
- `packages/realtime-contracts` owns versioned server event envelopes and reuses message response schemas from `api-contracts`.
- `packages/domain` contains storage ports, the community service, authorization rules, and an in-memory test adapter without transport-specific logic.
- `packages/postgres` implements the storage ports, connection pooling, schema verification, and concurrency-safe migrations.

Malformed HTTP input returns a stable `invalid_request` response with a correlation ID and no validation internals. Malformed WebSocket messages return `invalid_message`; unknown resources return `not_found`; unauthorized subscriptions return `forbidden`.

## Desktop status

The web/domain split is suitable for a thin Tauri shell without duplicating interface or domain logic, but the desktop scaffold is deferred because `rustc`, `cargo`, and the Tauri CLI are not installed locally. Xcode 26.6 is available.

Before adding `apps/desktop`, install the stable Rust toolchain (including `rustc` and `cargo`) using the official Rust installer, ensure the macOS Xcode command-line tools are selected, and make the Tauri CLI available as a repository-local development dependency. The future desktop package should load or build `apps/web` and expose root-level desktop development and build commands.

## Current limitations

- PostgreSQL persistence is implemented. Valkey and object storage are not connected to application flows.
- Identity and WebSocket subscription authorization are development-only. A subscription is limited to the account that owns the space's community.
- There is no desktop application scaffold until the documented toolchain is available.
- Production authentication, voice, video, federation, and peer-to-peer transport are planned work, not implemented behavior.

Further context is in the [architecture record](docs/architecture/0001-application-language.md), [operations guide](docs/operations/development.md), [security policy](SECURITY.md), and [roadmap](ROADMAP.md).

## License

Licensed under `GPL-3.0-only`. See [LICENSE](LICENSE) for the complete GNU General Public License version 3 text.
