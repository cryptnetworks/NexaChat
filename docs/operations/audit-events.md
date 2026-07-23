# Administrative audit events

## Versioned allowlist and privacy boundary

PostgreSQL is authoritative for administrative audit events. Version 1 records contain only: event ID and schema version; account or bounded service identity; instance/community scope; typed target and target ID; allowlisted action and outcome; bounded reason code; server-generated correlation ID; occurrence and seven-year retention timestamps; community-local sequence; previous hash; and event hash. Version 2 uses the same privacy-safe hash vector and allowlist shape for account-recovery controls, preserving readers and chain verification while adding recovery actions. Account and service identities are mutually exclusive. Service IDs must match the database's bounded lowercase identifier rule.

The version-1 action allowlist is `invitation.create`, `invitation.revoke`, `invitation.accept`, `audit.checkpoint`, `audit.legal_hold.apply`, `audit.legal_hold.release`, `account.credentials.change`, `account.session.revoke`, `account.sessions.revoke_all`, and `account.sessions.revoke_others`. Version 2 additionally allows `account.recovery.request`, `account.recovery.complete`, `account.recovery.method.verify`, `account.recovery.method.revoke`, `account.recovery.operator.lock`, `account.recovery.operator.unlock`, and `account.recovery.operator.invalidate`. Outcomes are `succeeded` and `rejected`. Reason codes are machine-readable enums or bounded identifiers, never exception messages or operator prose. Credential, session, and recovery controls use instance scope with an account target; they contain no submitted values, recovery tokens or hashes, internal session IDs, public session handles, destinations, or device fingerprints.

Tokens and token hashes, credentials, cookies, request bodies, message content, addresses, session/API-token values, private hostnames, provider diagnostics, stack traces, and arbitrary metadata are never audit fields. API response schemas are strict and tests assert the exact allowlist. New fields or actions require a new supported event version, migration, compatibility review, hash-vector update, privacy review, and restore fixture.

## Transactionality, ordering, and integrity

Successful invitation mutations append their event in the same PostgreSQL transaction as authoritative state. A write or its required audit record therefore commits completely or rolls back completely. Rejected attempts append a separate safe event after the rejected transaction; audit storage failure never replaces or discloses the original denial. HTTP operations propagate the server-generated request correlation ID. Non-request service jobs must provide their own UUID correlation and bounded service identity.

Migration 0007 installs `pgcrypto`, backfills version-6 rows deterministically, and adds a database trigger. Before each insert the trigger takes a transaction-scoped advisory lock for the community, assigns the next positive sequence, copies the prior SHA-256 hash (or 64 zeroes for the first event), and hashes every allowlisted version-1 field. Concurrent writers therefore produce one ordered chain without a read/write race; separate communities do not contend on a global lock.

Database triggers reject every `UPDATE` and `DELETE` against `audit_events` and `audit_checkpoints`. Corrections, retention holds, and releases are new events. Hash verification reads in bounded 1,000-row pages and recomputes the complete chain from sequence 1.

## Checkpoints and alerts

`POST /v1/communities/:communityId/audit-events/checkpoints` appends an `audit.checkpoint` event and a matching immutable checkpoint in one transaction. The database locks the community and rejects a checkpoint unless its sequence/hash is the current head. Integrity responses include the current head plus the latest checkpoint sequence/hash and whether that historical chain row still matches.

Persisted checkpoints detect accidental mismatch and support backup/restore verification, but a privileged database operator could replace both tables and verifier code. Export checkpoint evidence to an independently controlled, append-only system on the compliance schedule. Compare its last accepted head before accepting a newer checkpoint.

`nexa_audit_integrity_checks_total` exposes only `valid`, `invalid`, and `checkpoint_mismatch`. Invalid results also emit the bounded `audit.integrity.failed` structured event with correlation and trace identifiers but no resource, actor, or record fields. Alert immediately on either failure outcome, stop administrative writers for that community, preserve database and external checkpoint evidence, restore only from a verified complete backup, and re-run verification before reopening writes.

## Authorization, query, retention, and legal hold

Every endpoint authenticates the requester, revalidates `moderation.audit` at community scope, and uses non-disclosing authorization errors:

- `GET /v1/communities/:communityId/audit-events` returns stable ascending pages;
- `GET /v1/communities/:communityId/audit-events/integrity` verifies chain and checkpoint;
- `GET /v1/communities/:communityId/audit-events/export` returns one bounded UTF-8 NDJSON page;
- `POST /v1/communities/:communityId/audit-events/checkpoints` creates an immutable checkpoint;
- `GET /v1/communities/:communityId/audit-events/retention` reports the fixed `security_7y` policy, current legal-hold state, and last retention-eligible sequence; and
- `POST /v1/communities/:communityId/audit-events/legal-hold` appends a reason-coded hold or release directive.

Page size defaults to 50 and is capped at 100. Cursors encode only the last sequence. Export is deliberately paginated. Legal hold always forces `eligibleThroughSequence` to zero. A hold release does not delete anything; it only restores time-based eligibility. The application never deletes audit rows, and eligibility is not deletion authority. Archival or later partition retirement requires a verified export, an external checkpoint, backup-policy compliance, security/compliance approval, and a re-check that no hold is active. Never prune an individual row or checkpoint because doing so breaks chain continuity.

The current web client has no administration surface. A future viewer must preserve focus, expose loading/empty/success/error states as text, make paging/export/checkpoint/hold controls keyboard operable, announce integrity failures without flooding a live region, and never use color alone.

## Backup, restore, migration, and recovery

PostgreSQL backups include audit rows and checkpoints; object-storage backup manifests protect any separately exported checkpoint evidence. The isolated encrypted restore verification seeds a known audit row/checkpoint, restores the database, recomputes the complete allowlisted SHA-256 record, and requires the checkpoint to match its restored chain row. This runs alongside manifest authentication, component integrity, incomplete-backup, retention/pruning, migration compatibility, object-byte, and credential-rotation controls.

Before migration 0007, take and verify an encrypted backup. The migration obtains locks while backfilling and supports empty databases plus ordered upgrades through version 6. Recovery version 2 audit events and 0047 idempotency/operator tables are included in the encrypted restore fixture. It is forward-only because removing its columns, constraints, triggers, or checkpoint table discards integrity evidence.

Verification commands:

```sh
npx vitest run packages/domain/test/audit-events.test.ts apps/server/test/audit-events.integration.test.ts
npm run test:postgres
npm run verify:clean-env
npm run verify:backup-restore
```

During PostgreSQL loss, audit endpoints fail rather than serving stale data and readiness reports the required dependency. After recovery, verify the chain, the latest database checkpoint, and the independently stored head before administrative operations resume. Rollback uses an older application only when it explicitly supports the deployed schema. Otherwise fix forward or restore the complete pre-migration PostgreSQL backup with its matching application revision. Never copy only audit tables, edit migration history, disable append-only triggers, rewrite hashes, or partially restore providers.
