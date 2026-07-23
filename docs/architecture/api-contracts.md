# HTTP API contracts and failure semantics

All HTTP responses include `X-Request-Id` (a UUID suitable for support
correlation) and `X-API-Version: 1`. Request IDs contain no account, resource,
credential, token, or content data. Errors disable caching and use one additive,
versioned JSON shape:

```json
{
  "version": 1,
  "error": "invalid_request",
  "correlationId": "uuid",
  "retryable": false
}
```

Stable public codes are defined only in `@nexa/api-contracts`. Validation
details, database errors, authorization reasons, private target existence, and
dependency addresses never cross the transport boundary. Authorization is
enforced in services and transactions; hiding an interface element is not an
authorization control. Sensitive missing and unauthorized resources deliberately
share `not_found` or their feature-specific non-disclosing code.

Clients may automatically retry only when `retryable` is true. HTTP 429 includes
integer `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` headers from the server-owned fixed window. A 503 caused by an
unavailable limiter includes the same bounded metadata and
`dependency_unavailable`; readiness 503 includes `Retry-After: 5`. Callers
should use bounded exponential backoff and must not treat a retry as evidence
that an earlier command failed. Other 4xx responses require user or request
correction. A generic 500 is not declared safe to retry because command
completion can be uncertain; idempotency keys must be used where the command
contract provides them.

JSON request bodies default to 16 KiB and return `payload_too_large` with 413.
Requests have a 15-second default timeout. HTTP request admission defaults to
1,000 requests per 60 seconds and applies independent bounded route-class,
address, community, and verified-account counters. Enabled Valkey coordination
makes these atomic and shared across replicas. Authentication, account, session,
API-token, invitation, WebSocket, webhook, administration, mutation, and read
groups have bounded policy caps. A disabled coordination adapter uses a
10,000-key local store for single-process operation. If an enabled adapter
fails, credential, token, invitation, WebSocket, webhook, and administrative
traffic fails closed; ordinary traffic uses the bounded local store and reports
degradation.
Configuration is range-validated before binding sockets. The complete policy is
in `docs/operations/rate-limiting.md`.

Collections use a maximum page size of 100 and opaque cursors no longer than 256
characters. Cursors encode server-owned stable ordering tuples and are never
accepted as authorization evidence. Responses contain `items` and nullable
`nextCursor`; clients stop when it is null. Malformed cursors receive
`invalid_request`. Message history additionally accepts `direction=backward`.
The first backward page is the newest authorized page, returned in chronological
order; each following cursor returns the next older chronological page. The
direction changes traversal only, never the authorization check or stable
`createdAt`/identifier ordering.

Authenticated session inventory returns only a distinct revocation handle,
coarse lifecycle timestamps, and the current-session flag. Internal session
IDs, token material, source addresses, user-agent strings, and inferred
locations are not contract fields. Owned revocation and all-other revocation
use exact Origin and CSRF checks, revalidate account ownership, and return
non-disclosing results.

Administrative audit query, integrity, checkpoint, retention, legal-hold, and
NDJSON export endpoints require the community-scoped `moderation.audit`
permission. Query and export use the same ascending community sequence, maximum
page size of 100, and opaque next cursor. Version-1 responses expose only typed
actor, scope, target, action, outcome, reason, correlation, retention, and
integrity fields in `docs/operations/audit-events.md`; credentials, content,
network addresses, and provider details are not contract fields. Integrity and
checkpoint failure are returned as data so an authorized operator can preserve
evidence and escalate without an automatic retry loop.

Optimistic versions return `stale_write` for losing mutations. Scoped unique
conflicts return `conflict`. Message creation and invitation acceptance document
their own idempotency behavior. PostgreSQL constraints and transactional
conditional updates are authoritative under concurrency.

Operational recovery is forward-only: restore the required dependency, confirm
`/health/ready`, and retry only according to the metadata above. Audit migration
0007 and later audit extensions are forward-only; older applications must
explicitly support the deployed database schema before rollback. Clients that
depend on version-1 audit records must accept the version-2 recovery records
introduced by the current release.
