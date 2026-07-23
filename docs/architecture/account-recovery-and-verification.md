# Account recovery and verification

Status: approved design for Phase 1 issue #35. This document defines the
provider-neutral contract used by the recovery core (#187), encrypted delivery
outbox (#188), and accessible web flow (#189). It does not enable a delivery
provider or create a recovery session.

## Goals and trust boundaries

Recovery restores access to an account without treating possession of an email
address, a browser, a delivery provider, or an operator UI as authorization by
itself. PostgreSQL is authoritative for account state, recovery epochs, method
ownership, challenge use, retention, and audit. Valkey is a bounded admission
and abuse-control dependency, never an authority source. The delivery outbox
holds encrypted payloads and is the only component allowed to hand a token to a
configured provider adapter. The browser may submit a token but cannot create,
read, or validate recovery state locally.

Provider adapters are untrusted effectors. They receive a fixed delivery
envelope only after a transactional outbox claim and return one of the
allowlisted outcomes `accepted`, `transient_failure`, or `permanent_failure`.
Provider names, diagnostics, destinations, tokens, and token hashes never enter
the public contract, logs, metrics, traces, audit events, notifications, or
URLs.

## Lifecycle states and ownership

### Recovery method

Each method is account-owned and has a stable opaque identifier, a normalized
method kind, an encrypted destination reference, a verification state, a
created timestamp, a last-verified timestamp, and a version. The destination
is not returned to the browser; UI may receive only a coarse masked summary
when the authenticated account is already authorized to manage its methods.

The method state is one of:

- `pending`: enrollment or replacement is not verified and cannot recover an
  account;
- `verified`: eligible for recovery and verification, subject to account
  policy;
- `revoked`: permanently ineligible; its ciphertext is erased according to
  retention policy.

Replacement is two-phase. The old verified method remains authoritative until
the new method's verification challenge commits. A failed, expired, or revoked
replacement never disables the old method. Revocation is transactional and
must leave the account either recoverable by another verified method or in the
explicit `unrecoverable` state.

### Challenge

A challenge belongs to one account, one purpose, one recovery epoch, and one
method or authenticated enrollment operation. Its state is `pending`, `used`,
`expired`, or `invalidated`. The database stores only a cryptographic hash of
the token plus a keyed purpose and epoch binding; plaintext exists only in the
bounded request or outbox worker memory.

Challenge purposes are fixed and versioned:

- `account_recovery`: permits password replacement after recovery checks;
- `method_enrollment`: verifies a new method for an authenticated account;
- `method_replacement`: verifies a replacement while the old method remains
  authoritative;
- `method_revocation`: confirms a destructive self-service revocation when
  policy requires an additional verified method.

Every challenge has a stable ID, a 30-minute recovery or 15-minute verification
expiry, a single-use condition, a bounded attempt counter, and the epoch that
was current when it was issued. Incrementing the account recovery epoch
invalidates all older challenges without enumerating them.

### Account recovery state

The effective account state is derived transactionally:

- `recoverable`: at least one verified method is current and usable;
- `unrecoverable`: no verified method is available; normal login remains
  unchanged and operator controls cannot set a password or bypass verification;
- `locked`: an operator recovery lock blocks challenge issuance and redemption;
- `suspended`: account policy blocks recovery until an authorized operator
  restores the account.

The public API does not reveal which state an unknown, suspended, locked, or
unrecoverable account has.

## Token and privacy rules

Tokens contain at least 256 bits of cryptographic entropy, are URL-safe, and
are never placed in a query string, cookie, local storage, session storage,
analytics event, referrer-visible URL, cross-tab message, error report, log,
metric, trace, audit event, provider diagnostic, or notification. The web flow
accepts a delivered token only from the URL fragment, removes the fragment
with `history.replaceState` before network or third-party-capable activity, and
supports bounded manual entry without automatic resubmission.

The server compares a hash of the token in constant-time-safe library code and
checks purpose, account, epoch, expiry, state, and attempt budget in one
transaction. A wrong, missing, expired, used, replayed, stale-epoch, or
dependency-failed token returns the same generic `recovery_failed` result.

## HTTP contract

The contract is additive to API version 1 and uses the repository error shape.
All mutating requests require the existing authenticated session, exact Origin,
CSRF header, and normal request limits unless explicitly identified as public
recovery endpoints.

| Operation                                       | Authentication                        | Public result                                                              |
| ----------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `POST /v1/auth/recovery/request`                | none                                  | Always generic `202`; never indicates account, method, or delivery state   |
| `POST /v1/auth/recovery/complete`               | none                                  | `204` on the single successful commit; generic `recovery_failed` otherwise |
| `GET /v1/account/recovery-methods`              | current session                       | Masked method summaries only                                               |
| `POST /v1/account/recovery-methods`             | current session plus recent auth      | Creates a pending method and an outbox challenge                           |
| `POST /v1/account/recovery-methods/:id/verify`  | current session                       | Verifies only the caller's pending method                                  |
| `POST /v1/account/recovery-methods/:id/replace` | current session plus recent auth      | Starts two-phase replacement                                               |
| `POST /v1/account/recovery-methods/:id/revoke`  | current session plus policy challenge | Revokes only the caller's method                                           |

Request bodies have strict bounds. Responses never include challenge IDs,
destinations, token material, hashes, provider fields, or account-existence
signals. Recovery completion changes the password, increments credential and
recovery epochs, revokes every HTTP session, invalidates every challenge, and
returns no session. The user is directed to normal login.

## Transaction and concurrency contract

Recovery request and completion use one serializable PostgreSQL transaction for
the account, recovery epoch, challenge, method, session revocation, security
notification, audit event, and outbox row. The transaction locks the account
authority row and the relevant method/challenge rows in deterministic order.
The winner of concurrent completion, password change, logout-all, method
replacement, or operator invalidation is the only operation that can commit;
losers receive a stable generic or stale result and create no partial records.

Commands have caller-supplied idempotency keys with bounded length. A replay
with the same key and request fingerprint returns the original safe outcome; a
different fingerprint is `conflict`. Serialization failures have a bounded
server retry budget. Clients must retry only when the response declares it
safe, and must reuse the same idempotency key after an ambiguous network
failure.

Recovery success must revoke existing WebSocket sessions before the response
is returned. Reconnect and tab synchronization carry only an allowlisted
credential-rotation action, never an account ID, challenge ID, token, or
destination. Existing realtime authorization remains authoritative on the
server.

## Rate limits and failure behavior

Public recovery requests use shared Valkey limits for route, source address,
account digest when safely known, and recovery method digest. Counters have
bounded cardinality, short TTLs, and no raw identifiers. Unknown-account and
known-account requests have equivalent response shape and bounded work. A
failed Valkey dependency fails closed for recovery issuance and redemption;
PostgreSQL failure returns the same generic dependency-safe recovery result.

Challenge expiry is checked before delivery and again before redemption. A
worker crash leaves a leased outbox row reclaimable, but never restores a token
whose challenge is expired, used, invalidated, or from an older epoch. Delivery
attempts are capped at five with bounded jitter. Permanent failure, expired
state, and exhausted retries erase encrypted payload material and retain only
an allowlisted terminal outcome.

## Operator boundary

Operators may view bounded aggregate state and may lock, unlock, invalidate, or
revoke recovery state through scoped, recent-authenticated, audited controls.
They may not retrieve destinations or tokens, set a password, verify a method,
disable epoch checks, or bypass the normal recovery flow. Operator responses
are non-disclosing and do not distinguish a missing account or method.

## Audit, notification, and observability

Recovery adds a new versioned audit event family only after compatibility and
hash-vector review. Allowlisted fields are event version, action, outcome,
bounded reason code, scope, target type without a private target identifier,
correlation ID, timestamp, retention, and chain fields. It excludes account
names, destinations, tokens, hashes, cookies, sessions, addresses, user agents,
provider IDs, and content.

Security notifications are generic events such as `recovery_requested`,
`credentials_recovered`, `method_verified`, and `method_revoked`; they contain
no recovery link or destination. Metrics are aggregate counters and bounded
latencies by purpose, outcome, and dependency state. Logs record only stable
safe event names and correlation IDs.

## Migration, backup, and rollback

The implementation must add forward-only migrations for methods, epochs,
challenges, and outbox references with checks, indexes, retention cleanup, and
no destructive rewrite of existing account or session data. Migrations must
work from an empty schema and every supported schema version. Backup fixtures
use synthetic destinations and tokens; adapters are disabled during restore.
Restore verification must reject a missing or wrong key, invalidate restored
pending challenges before service start, and prove that verified methods remain
usable without exposing plaintext.

Rollback is application-only before the recovery migrations are adopted. After
adoption, use a release that explicitly supports the new schema or restore the
complete verified pre-migration backup; never delete only recovery tables or
edit migration history. Key installation, rotation, compromise, key loss,
provider outage, pause/resume, re-encryption, and rollback procedures belong
to the outbox operations document in #188.

## Accessibility and client behavior

The web implementation must provide labelled controls and semantic status for
loading, accepted, empty/unrecoverable, expired, used, throttled, dependency,
generic-error, verification, revocation, and success states. Focus moves to
the first actionable error or success heading, destructive dialogs trap focus,
support Escape, and restore focus to the initiating control. The flow must
work by keyboard, at 320-pixel width and 200% zoom, in forced colors and
reduced motion, with bounded polite live-region announcements and no color-only
meaning. A manual assistive-technology matrix remains required in addition to
automated Playwright and axe checks.

## Delivery order

1. Land and review this design.
2. Implement schema, challenge state, epochs, HTTP core, and atomic session
   revocation in #187.
3. Implement encrypted outbox, key lifecycle, provider adapter boundary, and
   restore/runbooks in #188.
4. Implement fragment-safe, accessible web flows and cross-tab/realtime
   invalidation in #189.

Each implementation must preserve this document's state machine and generic
failure semantics. Any contract, retention, provider, or operator-boundary
change requires a design update and compatibility review before code lands.
