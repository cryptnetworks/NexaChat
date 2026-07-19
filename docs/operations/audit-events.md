# Administrative audit events

## Ownership and recorded fields

PostgreSQL is authoritative for administrative audit events. The initial action allowlist is `invitation.create`, `invitation.revoke`, and `invitation.accept`; outcomes are `succeeded` or `rejected`. Records contain only the event identifier, actor identifier, optional community and invitation identifiers, action, outcome, occurrence time, community-local sequence, previous hash, and event hash. Tokens, token hashes, credentials, request bodies, message content, addresses, session identifiers, and provider diagnostics are never audit fields.

Successful invitation mutations append their event in the same database transaction as authoritative state. A best-effort rejected event never replaces or discloses the original denial when storage is unavailable. Audit rows do not grant access and are not an authorization source.

## Integrity and concurrency

Migration 0007 installs `pgcrypto`, backfills existing version-6 rows deterministically, and adds a database trigger. Before each insert the trigger takes a transaction-scoped advisory lock for the community, assigns the next positive sequence, copies the prior SHA-256 hash (or 64 zeroes for the first event), and hashes the complete allowlisted record. Concurrent writers therefore produce one ordered chain without a read/write race. Separate communities do not contend on one lock.

Database triggers reject every `UPDATE` and `DELETE` against `audit_events`. Corrections must be new explicitly modeled events; operators must not disable the triggers. Hash verification recomputes the chain from the first event and returns `valid`, count, and current head hash. Hashes make mutation detectable but do not prevent a privileged database operator from replacing the table and its verification code. Periodically checkpoint community head hashes into an independently controlled system if protection from database-administrator compromise is required.

## Authorization, query, and export

All three endpoints authenticate the requester, revalidate `moderation.audit` at community scope, and return the same non-disclosing authorization errors as other community APIs:

- `GET /v1/communities/:communityId/audit-events` returns a stable ascending sequence page;
- `GET /v1/communities/:communityId/audit-events/integrity` verifies the chain; and
- `GET /v1/communities/:communityId/audit-events/export` returns the same bounded page as UTF-8 NDJSON and places the next opaque cursor in `X-Next-Cursor` when present.

Page size defaults to 50 and is capped at 100. Cursors encode only the last sequence. Export is deliberately paginated rather than an unbounded archive job. Missing communities, invalid limits/cursors, stale permissions, and storage failures use existing stable API errors. The PostgreSQL dependency is required: outages fail requests without serving stale audit data, while existing readiness and dependency telemetry expose the failure and recovery.

The current web client has no administration surface. A future audit viewer must preserve focus, expose loading/empty/success/error states as text, make paging and export keyboard operable, announce integrity failures, and never use color alone for integrity state.

## Migration, verification, and recovery

Before migration 0007, take and verify an encrypted backup. The migration obtains locks while it backfills rows; schedule it before starting new application instances. It supports empty databases and ordered upgrades through version 6. It is forward-only because removing the append-only columns/triggers would discard integrity history.

Verification commands:

```sh
npx vitest run packages/domain/test/audit-events.test.ts apps/server/test/audit-events.integration.test.ts
npx vitest run packages/postgres/test/postgres.integration.test.ts
npm run verify:clean-env
```

After deployment, query one known community, verify `valid: true`, export every bounded page, and store the reported head hash with the evidence. During a PostgreSQL outage, confirm audit endpoints fail and readiness reports the required dependency; after recovery, rerun verification before administrative operations resume.

Rollback uses the previous application only if it tolerates schema version 7; current schema verification intentionally prevents an older binary expecting version 6 from starting. The safe recovery path is to fix forward or restore the complete pre-migration PostgreSQL backup together with the matching application revision. Never copy only `audit_events`, prune rows, or rewrite hashes.
