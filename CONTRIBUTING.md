# Contributing

Use Node.js and npm versions declared in `package.json`. Before proposing a change, run formatting, linting, type checking, tests, and builds. Keep changes cohesive and update behavior documentation.

Public HTTP or realtime contract changes must follow `docs/architecture/contract-evolution.md`, update the committed synthetic fixtures under `contracts/`, and pass `npm run test:contracts`. Existing version fixtures are immutable compatibility evidence; breaking changes require a parallel explicit version and migration guidance.

Branches use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `security/` plus a short description. Commits use Conventional Commits such as `feat(server): add community creation`.

Pull requests explain the problem and solution, security/privacy/migration/accessibility/operational effects, and a test plan. Visible changes include screenshots. Architecture changes use an ADR. Report vulnerabilities through the process in `SECURITY.md`, not a public issue.
