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
an integer `Retry-After` header and uses bounded server windows. Readiness 503
includes `Retry-After: 5`; callers should use bounded exponential backoff. Other
4xx responses require user or request correction. A generic 500 is not declared
safe to retry because command completion can be uncertain; idempotency keys must
be used where the command contract provides them.

JSON request bodies default to 16 KiB and return `payload_too_large` with 413.
Requests have a 15-second default timeout. The instance-level address limiter
defaults to 1,000 requests per 60 seconds, caps its in-memory key set at 10,000,
and is configured independently from stricter authentication, invitation, and
WebSocket limits. Configuration is range-validated before binding sockets.

Collections use a maximum page size of 100 and opaque cursors no longer than 256
characters. Cursors encode server-owned stable ordering tuples and are never
accepted as authorization evidence. Responses contain `items` and nullable
`nextCursor`; clients stop when it is null. Malformed cursors receive
`invalid_request`.

Optimistic versions return `stale_write` for losing mutations. Scoped unique
conflicts return `conflict`. Message creation and invitation acceptance document
their own idempotency behavior. PostgreSQL constraints and transactional
conditional updates are authoritative under concurrency.

Operational recovery is forward-only: restore the required dependency, confirm
`/health/ready`, and retry only according to the metadata above. This issue adds
no migration and can be rolled back at the application layer, but clients that
depend on version-1 metadata should be treated as part of compatibility review.
