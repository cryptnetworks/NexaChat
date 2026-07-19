# Nexa Chat

Nexa Chat is an early-stage, self-hosted communication platform for persistent communities. The repository currently contains a Phase 0 foundation and a development-only vertical slice for creating an account, a community, a text space, and exchanging messages in real time.

The demo identity flow is not production authentication. It is disabled unless `NEXA_ENABLE_DEV_AUTH=true` and `NODE_ENV=development`.

## Requirements

- Node.js 24
- npm 11
- Docker with Compose (for infrastructure services)

## Start locally

```sh
npm ci
cp .env.example .env
docker compose up -d
npm run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:3000`.

## Verification

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

See [the architecture record](docs/architecture/0001-application-language.md), [operations guide](docs/operations/development.md), [security policy](SECURITY.md), and [roadmap](ROADMAP.md).

## License

Copyright © 2026 cryptnetworks.

NexaChat is licensed under GPL-3.0-only. See [LICENSE](LICENSE) for the
complete license terms and [NOTICE](NOTICE) for attribution.
