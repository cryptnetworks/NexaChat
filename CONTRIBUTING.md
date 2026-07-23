# Contributing

Use Node.js and npm versions declared in `package.json`. Before proposing a change, run formatting, linting, type checking, tests, and builds. Keep changes cohesive and update behavior documentation.

## Documentation

Keep [README.md](README.md) as a concise project entry point: status, features, prerequisites, minimal startup and deployment steps, and links to detailed guidance. Durable documentation belongs in [docs/](docs/), which is the source for the published [GitHub wiki](https://github.com/cryptnetworks/NexaChat/wiki).

- Put design decisions, service boundaries, API contracts, and desktop guidance in [docs/architecture/](docs/architecture/).
- Put development, deployment, container, data-service, backup, recovery, and observability guidance in [docs/operations/](docs/operations/).
- Put security, privacy, moderation, and lifecycle guidance in [docs/security/](docs/security/) and [docs/privacy/](docs/privacy/).
- Put release, upgrade, rollback, compatibility, and support policy in [docs/releases/](docs/releases/). Keep the accessibility baseline in [docs/accessibility.md](docs/accessibility.md).

Do not edit the generated wiki directly. When documentation or the exporter changes, run the [wiki publishing checks](docs/operations/wiki-publishing.md#local-verification), inspect the generated navigation and links, and keep the README limited to an index instead of duplicating operational detail.

Public HTTP or realtime contract changes must follow `docs/architecture/contract-evolution.md`, update the committed synthetic fixtures under `contracts/`, and pass `npm run test:contracts`. Existing version fixtures are immutable compatibility evidence; breaking changes require a parallel explicit version and migration guidance.

Workspace dependency changes must comply with `docs/architecture/dependency-boundaries.md` and pass `npm run test:architecture`. Add an exception only when no boundary-safe design is practical, with a narrow edge, owner, rationale, and removal date.

Automated and manual dependency changes follow `docs/operations/dependency-updates.md`. Major updates require release-note, compatibility, migration, rollback, and manual-test evidence; no dependency update is eligible for automatic merge.

Security and supply-chain changes follow `docs/operations/supply-chain-security.md`. Reproduce the relevant policy, secret, static, dependency, SBOM, provenance, and container gates locally. Suppressions require a named owner, technical rationale, compensating control, and expiration or review date.

Application-container changes follow
`docs/operations/container-applications.md` and pass `npm run
verify:container-policy`. When Docker is available, also run the bounded
development topology smoke test; production behavior requires the production
verification lane.

Durable-data, migration, storage, image, and deployment changes must follow
`docs/operations/backup-and-restore.md` and pass `npm run verify:backup-policy`
plus the complete disposable restore verification.

Branches use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `security/` plus a short description. Commits use Conventional Commits such as `feat(server): add community creation`.

Pull requests explain the problem and solution, security/privacy/migration/accessibility/operational effects, and a test plan. Visible changes include screenshots. Architecture changes use an ADR. Report vulnerabilities through the process in `SECURITY.md`, not a public issue.

`main` is protected: submit a pull request, address review feedback, and wait
for the required current checks and independent approval. Do not request or use
an administrator exemption to bypass those controls. Sensitive paths and the
emergency-control process are documented in
[`docs/security/repository-controls.md`](docs/security/repository-controls.md).
