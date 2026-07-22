# Data lifecycle and retention model

This document is the operational contract for NexaChat data. It applies to the
primary PostgreSQL database, private object storage, Valkey coordination state,
search projections, telemetry, exports, and backups. Product policy may shorten
retention within the hard bounds documented here; it may not bypass legal holds,
authorization, audit integrity, or sole-owner safeguards.

## Responsibility and authority

- Account owners may export their own data and request account deletion after
  recent authentication and explicit confirmation.
- Community administrators may configure community or space retention and
  export administrative community data only while currently authorized. They
  cannot export private reports, evidence, addresses, credentials, sessions, or
  direct conversations through a shared community resource.
- Moderators can access evidence only through a scoped moderation workflow.
  Moderation access does not grant export, retention-policy, or backup access.
- Instance operators maintain storage encryption, backup expiry, deletion
  workers, legal holds, recovery procedures, and audit verification. Operators
  must not use infrastructure access as a substitute for application
  authorization.

Every sensitive operation carries a correlation identifier. Logs and metrics use
job, account, community, and object-reference hashes; they never contain message
bodies, export keys, evidence, report descriptions, network addresses, tokens, or
credentials.

## Store-by-store lifecycle

| Store or record                                           | Purpose and authority                                      | Normal lifecycle                                                                                                | Hold, deletion, and recovery                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and credentials                                  | Authentication; account owner and auth service             | Active until deletion completes                                                                                 | Credentials and sessions are revoked, identity fields are tombstoned, and a non-reversible digest prevents accidental identity reuse. Sole owners must transfer or delete their communities first.                                                                                                             |
| Sessions                                                  | Short-lived authenticated access                           | Expire normally and are rotated after security events                                                           | All sessions are revoked atomically when deletion is scheduled. Session secrets never enter exports or backups intended for application restoration.                                                                                                                                                           |
| Communities, roles, memberships                           | Scoped authorization                                       | Retained while community exists                                                                                 | Account deletion removes memberships only after sole-owner validation. Stable actor identifiers remain in minimized audit records.                                                                                                                                                                             |
| Messages and edit history                                 | Conversation history                                       | Effective instance policy, overridden by community then space policy                                            | A worker uses bounded batches and durable checkpoints. Bodies, edits, reactions, and attachment references are purged together; stable tombstones remain while required for replies, unread cursors, or the tombstone policy. Holds are rechecked immediately before mutation.                                 |
| Attachments                                               | User-provided message objects in private object storage    | Inherit the parent message policy                                                                               | Database removal writes an object-deletion outbox entry. The object worker retries with a bounded attempt count; missing objects are idempotent success. Held attachment evidence is copied to the evidence store before ordinary removal.                                                                     |
| Reports, moderation evidence, cases, appeals, and actions | Safety review and due process                              | Evidence policy, normally 180 days after case closure                                                           | Legal holds override expiry. Reporter identity and evidence are never exposed through community exports. Deletion tombstones the subject identity but preserves evidence and case integrity until hold and policy release.                                                                                     |
| Audit events                                              | Accountability and integrity verification                  | Retained under the instance audit policy                                                                        | Excluded from message-retention deletion. Events are payload-minimized and hash-linked. Restoration must verify each chain before administrative access is re-enabled.                                                                                                                                         |
| Export jobs and archives                                  | Portable user or administrative export                     | Failed job metadata is minimized; ready user archives expire after 7 days and community archives after 48 hours | Archives use per-job AES-256-GCM encryption, private object references, and versioned integrity manifests. Revocation, expiry, and failure delete the object and key material. Metadata remains only for the audit period.                                                                                     |
| Account-deletion jobs                                     | Cooling-off, progress, and final evidence                  | Scheduled, running, held, completed, cancelled, or failed                                                       | Cancellation ends when the worker atomically claims the job. A held job is retried after release. Each irreversible step is idempotent or checkpointed.                                                                                                                                                        |
| Search projections                                        | Authorized discovery acceleration                          | Derived from current visible messages and safe member/space metadata                                            | Deletes, edits, retention, blocking, suspension, and permission loss enqueue prompt removal. Every query and result is reauthorized against PostgreSQL; the index never grants access. Rebuild from primary data after restoration.                                                                            |
| Valkey                                                    | Cross-instance fan-out, pacing, and bounded abuse counters | Ephemeral with explicit TTLs                                                                                    | Not a system of record. Restart or loss may reduce convenience but cannot restore permission or data. Rebuild subscriptions and counters conservatively.                                                                                                                                                       |
| Application logs and metrics                              | Reliability and security operations                        | Logs: 30 days; metrics: 90 days unless local law requires less                                                  | Structured redaction is mandatory. Never log bodies, report/evidence content, export keys, attachment URLs, addresses, or credentials. Correlation IDs support investigation without payload disclosure.                                                                                                       |
| Backups                                                   | Disaster recovery                                          | Encrypted rolling backups; default 35-day expiry                                                                | Completed deletions create a backup-exclusion tombstone. Restore into an isolated environment, apply deletion tombstones and expired-policy sweeps before network access, rebuild search, verify audit chains, then rotate credentials and keys. Backups are never searched to satisfy ordinary product reads. |

## Retention policy precedence

The effective message policy is the first configured policy in this order:

1. Space policy
2. Community policy
3. Instance policy
4. Safe built-in default: 365 days for content and 30 days for tombstones

The allowed range is 1–3,650 days. Policy writes require current management
authorization, an expected version, and an audit event. A shorter new policy does
not synchronously scan history. It schedules bounded deletion batches so database
load remains predictable. A dry run reports scanned, eligible, held, and projected
deletion counts without changing checkpoints or data.

Workers order candidates by purge time and stable identifier, cap each batch at
500 records, and save a cursor only after a failure-free batch. Temporary failures
leave the cursor unchanged so the batch is safe to replay. Individual deletion
steps and object outbox consumers are idempotent. Operators alert on failure
counts, oldest eligible age, held counts, retry exhaustion, and checkpoint age;
metrics contain no content.

## Legal holds and evidence

A legal hold names its scope, authority, reason code, creator, creation time, and
release time. Free-text justification is bounded and restricted. The deletion
worker obtains the candidate, reloads active holds, and deletes in one transaction
or records no mutation. Holds supersede retention and account deletion but do not
make evidence visible to additional roles.

Releasing a hold does not delete data immediately. It makes the record eligible
for the next scheduled policy pass and leaves a hash-linked audit event. Evidence
copied from a message records its original stable message ID and digest. Ordinary
message reads return only a tombstone after moderator deletion or retention and
never reveal the evidence snapshot.

## Export lifecycle

Exports require authentication within ten minutes, an explicit request, and a
maximum of three new jobs per requester per day. An idempotency key prevents
duplicate archives. Workers revalidate authorization after claiming a job and
before collecting data. Retrieval repeats recent-auth and current-authorization
checks and uses privacy-preserving not-found responses.

Each archive contains schema version `1`, stable resource identifiers, record
counts, per-resource SHA-256 values, and an archive digest. Resource names,
counts, archive size, and record counts are bounded. User exports contain only
the subject's portable records and content the subject may currently access;
shared resources are filtered so another participant's private fields or direct
content cannot leak. Community exports use an allowlist and redact private fields
by default.

Archives are encrypted before private-object upload. A job becomes ready only
after upload succeeds. If generation, encryption, upload, or the final state
transition fails, the worker deletes any partial object and records a bounded
failure code. Revocation or expiry removes both object and key material.

## Account deletion lifecycle

1. The account owner authenticates recently, enters the exact confirmation, and
   may link a completed personal export.
2. Scheduling and session revocation commit atomically. A seven-day cooling-off
   period begins; repeat submissions with the same idempotency key return the
   original job.
3. The owner may cancel before the due time and before worker claim. Claiming the
   job is the irreversible boundary.
4. At claim, the service rechecks sole ownership and active legal holds. The job
   remains blocked if either invariant prevents safe completion.
5. The worker removes memberships, tombstones authored-content ownership without
   changing message IDs, tombstones identity fields, records a backup exclusion,
   and writes final audit evidence. Steps are transactional or checkpointed and
   idempotent.

Held evidence, audit records, and immutable integrity fields survive deletion for
their applicable policy. Other members' messages, shared community structure, and
reply relationships are not deleted merely because the account participated.

## Backup restoration and incident recovery

Restoration is never complete when database import finishes. Before serving
traffic, operators must:

1. Keep the restored environment isolated and disable outbound notifications.
2. Apply every deletion tombstone newer than the backup and revoke restored
   sessions, credentials, export archives, and object links.
3. Run retention and export-expiry workers in dry-run mode, review bounded metrics,
   then execute until caught up.
4. Reconcile attachment outbox operations and confirm held objects remain private.
5. Rebuild search and derived read models from the authorized primary records.
6. Verify audit hash chains, rotate application and export keys, run privacy and
   authorization tests, then enable traffic.

Interrupted workers resume from persisted checkpoints. Operators retry bounded
failure classes and quarantine poison records without advancing the checkpoint.
Manual data mutation requires an incident record, two-person review, a correlation
identifier, and post-action integrity verification.

## Accessible user and administrator behavior

Retention previews, exports, deletion, and hold states must expose text labels—not
color alone—with keyboard-operable controls and programmatic status messages.
Long-running actions announce queued, running, blocked, ready, failed, expired,
revoked, cancelled, and completed states through an `aria-live="polite"` region.
Confirmation errors identify the field; focus moves to the error summary without
discarding entered data. Destructive buttons identify scope and cancellation
deadline. Progress polling respects reduced-motion preferences and never encodes
private identifiers in URLs, page titles, analytics, or browser notifications.

## Verification and review cadence

Release verification covers policy inheritance, expiry boundaries, holds,
interruption recovery, object cleanup, stale writes, export authorization loss,
cross-account disclosure, sole ownership, session revocation, cancellation races,
backup re-deletion, audit integrity, log redaction, and keyboard/screen-reader
flows. Operators review policy bounds, storage TTLs, backup expiry, deletion lag,
and restoration exercises at least quarterly.
