# NexaChat

NexaChat is an early-stage, self-hosted communication platform for persistent communities.

## Status

NexaChat is under active development. The current foundation includes authenticated accounts, communities, messaging, PostgreSQL persistence, browser realtime, and a thin desktop shell. Desktop signing, auto-updates, and platform validation are still in progress.

## Features

- Persistent communities, categories, spaces, messages, memberships, and audit records
- Argon2id authentication, revocable sessions, secure browser cookies, and scoped authorization
- Versioned HTTP and realtime contracts with privacy-aware error handling
- PostgreSQL persistence with forward-only migrations, optional Valkey coordination, and S3-compatible object storage adapters
- React web client and Tauri desktop shell

## Architecture

The Fastify server owns HTTP, WebSocket, and data access. The React/Vite client uses versioned API and event contracts. PostgreSQL is authoritative; Valkey and object storage support coordination and media workflows. See the [architecture reference](https://github.com/cryptnetworks/NexaChat/wiki/Architecture-Api-Contracts) for the complete design.

## Prerequisites

- Node.js 24.18.0 and npm 11.16.0
- Docker Engine with Docker Compose
- Rust 1.97.1 for desktop development

## Run locally

```bash
npm run dev:up
```

Open http://localhost:5173. This starts the local web application and its required services. For configuration, migrations, troubleshooting, end-to-end testing, and the desktop workflow, use the [development guide](https://github.com/cryptnetworks/NexaChat/wiki/Operations-Development).

## Deploy

For a basic production deployment, provide the required production environment values and run:

```bash
docker compose -f compose.production.yml config --quiet
docker compose -f compose.production.yml up --build --wait
```

The development Compose setup is not a production configuration. Review the [production deployment guide](https://github.com/cryptnetworks/NexaChat/wiki/Operations-Production-Deployment) before exposing an instance to users.

## Documentation

The repository's [docs/](docs/) directory is the documentation source of truth; the [GitHub wiki](https://github.com/cryptnetworks/NexaChat/wiki) is its published, browsable form.

| Topic                                             | Guide                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture, API, and realtime contracts         | [Architecture](https://github.com/cryptnetworks/NexaChat/wiki/Architecture-Api-Contracts)                                                                      |
| Development, deployment, containers, and recovery | [Operations](https://github.com/cryptnetworks/NexaChat/wiki/Operations-Production-Deployment)                                                                  |
| Security, privacy, and data lifecycle             | [Security and privacy](https://github.com/cryptnetworks/NexaChat/wiki/Security-Threat-Model)                                                                   |
| Releases, upgrades, compatibility, and support    | [Published policy](https://github.com/cryptnetworks/NexaChat/wiki/Releases-Support-Compatibility) · [canonical source](docs/releases/support-compatibility.md) |
| Accessibility                                     | [Accessibility baseline](https://github.com/cryptnetworks/NexaChat/wiki/Accessibility)                                                                         |

## Security, contributing, and license

Please report vulnerabilities through the private process in [SECURITY.md](SECURITY.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). NexaChat is licensed under [GPL-3.0-only](LICENSE); third-party notices are in [NOTICE](NOTICE).
