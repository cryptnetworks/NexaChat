# Workspace dependency boundaries

NexaChat is a modular monolith. `architecture-boundaries.json` is the reviewed
allowlist for dependencies between its npm workspaces, while each workspace
`package.json` remains the source of truth for dependencies it actually uses.
CI runs `npm run test:architecture` to enforce both views.

The independent core packages (`domain`, `auth`, and `authorization`) depend on
no other NexaChat workspace. Contract packages contain transport shapes;
realtime contracts may reuse HTTP resource schemas. PostgreSQL is an outbound
adapter and may implement core persistence/auth/authorization ports. The server
composition root may depend on every backend module. The browser application
may depend only on public contract packages and must never import server,
database, domain implementation, authentication, or authorization code.

The checker rejects:

- a local dependency not present in the directional allowlist;
- a workspace import absent from the importing package's manifest;
- deep `@nexa/*/...` imports that bypass a package's public entry point;
- cycles in the local workspace dependency graph;
- a new workspace that has not been explicitly classified.

Checks cover production and test source because tests must exercise public
boundaries too. External npm packages are outside this architectural allowlist
and remain governed by the lockfile, audit, and dependency maintenance policy.

## Exceptions and recovery

Exceptions live in the top-level `exceptions` array and require `from`, `to`,
`owner`, `rationale`, and ISO `removeAfter` fields. They waive only one declared
directional edge; they do not waive undeclared imports, deep imports, or cycles.
No exceptions currently exist. Reviewers must reject vague or perpetual entries
and require a tracking issue in the rationale.

A failing check blocks integration. Recovery is to move shared behavior behind
an existing public boundary, extract an independent package, declare a missing
dependency when its direction is already allowed, or remove the cycle. Editing
the allowlist to mirror an accidental dependency is an architecture change and
requires explicit review. This enforcement adds no runtime code, data migration,
network access, secret handling, deployment state, or user-facing behavior.
