# Distributed request rate limiting

## Public behavior and ownership

The HTTP service owns request admission. Authorization and authoritative PostgreSQL state are revalidated after admission; interface visibility, a claimed account identifier, a proxy header, or a successful limit check is never authorization evidence. Valkey owns only expiring, reconstructible counters. A counter eviction can admit additional traffic but cannot grant access or change domain state.

Every non-operational HTTP request consumes an address counter before its handler. After authentication proves that the session account matches the claimed actor, the request also consumes that account counter. Development-only actor claims use a separate `development` trust key. Operational probes and `/metrics` are excluded so an overload or Valkey outage cannot prevent orchestration from observing the process.

Keys contain only bounded enums plus a SHA-256 digest of the scope, trust level, and identity. Raw addresses, account identifiers, paths, query strings, credentials, tokens, and content are never stored in keys, logs, or metrics. Counters expire with the configured window and are not backed up.

## Policy

`NEXA_SERVER_RATE_LIMIT` is the base address and account limit; `NEXA_SERVER_RATE_WINDOW_SECONDS` is the fixed window. Defaults are 1,000 requests in 60 seconds. Both values are range-validated before any listener is bound. Endpoint limits are deterministic caps on the configured base:

| Endpoint group                                     |     Address cap |                 Verified-account cap | Dependency failure     |
| -------------------------------------------------- | --------------: | -----------------------------------: | ---------------------- |
| Authentication (`/v1/auth/*`)                      |              20 | Not applicable before authentication | Fail closed with 503   |
| Invitations (any version-1 invitation route)       |              60 |                                  120 | Fail closed with 503   |
| Other mutations (`POST`, `PUT`, `PATCH`, `DELETE`) |             300 |                                  600 | Bounded local fallback |
| Reads (`GET`, `HEAD`)                              | Configured base |                      Configured base | Bounded local fallback |
| Other methods                                      | Configured base |                      Configured base | Bounded local fallback |

The effective limit is the smaller of the configured base and the cap. Lower values therefore remain useful in tests and constrained deployments. Address and account scopes are independent; a request must pass both when both apply. The canonical address resolver ignores forwarding headers from untrusted peers and walks configured proxy hops from right to left.

Authentication retains its identifier/source limiter as defense in depth. WebSocket connection, subscription, and message limits remain independent because their lifecycle is not an HTTP request window.

## Atomicity and retry metadata

The Valkey adapter increments and establishes expiration in one Lua operation. The operation returns the resulting count and remaining TTL, so concurrent replicas make one deterministic decision at the boundary. There is no read-then-write race. The adapter bounds connection/operation timeouts and uses its existing circuit breaker.

Every rate-limit admission or rejection returns:

- `RateLimit-Limit`: the active scope’s limit;
- `RateLimit-Remaining`: non-negative remaining requests in that window; and
- `RateLimit-Reset`: integer seconds until the fixed window expires.

A 429 also returns the same integer in `Retry-After`, the stable `rate_limited` error, and `retryable: true`. A fail-closed dependency rejection returns 503, `dependency_unavailable`, `retryable: true`, and a retry delay no greater than five seconds. Clients use bounded backoff and preserve command idempotency keys.

## Outage, recovery, and observability

When coordination is intentionally disabled, a single process uses a local fixed-window store capped at 10,000 keys. This mode is not a shared multi-replica control. When enabled coordination becomes unavailable:

- authentication and invitation routes reject before parsing credentials, tokens, or private content;
- other reads and mutations use the same policy in the bounded local store so an optional coordination outage does not remove ordinary PostgreSQL availability; and
- each process probes the shared backend on subsequent operations and returns to shared counters without restart when the adapter and circuit recover.

The `nexa_rate_limit_decisions_total` counter exposes only bounded `scope`, `endpoint`, `outcome`, and `backend` dimensions. `dependency_failure`, `degraded`, and `limited` outcomes are alert inputs. Provider messages and identities are not diagnostic fields. Coordination health continues to appear in readiness as an optional degraded dependency.

Recommended alerts compare `limited` and `dependency_failure` rates to the request baseline. A sustained shared-to-local transition on ordinary traffic or any sensitive fail-closed rejection warrants investigation. Do not alert on individual addresses or accounts.

## Deployment, verification, and rollback

Production Compose enables the Valkey coordination adapter and passes its file-backed URL to the server. Multi-replica deployments must enable coordination with one shared namespace and must not rely on local mode. Valkey credentials, TLS requirements, resource limits, network isolation, and rotation follow `docs/operations/production-deployment.md`.

Run focused verification with:

```sh
npm run test:coordination
npx vitest run apps/server/test/rate-limit.test.ts apps/server/test/api-contract.integration.test.ts apps/server/test/proxy.integration.test.ts
```

For a live outage exercise, set `COORDINATION_TEST_URL` to a disposable Valkey endpoint, run the coordination suite, stop Valkey, confirm sensitive 503 and ordinary-route local admission, restart Valkey, and confirm the shared backend metric resumes. Test two application instances against one Valkey and confirm the second instance sees the first instance’s counter. Confirm no raw address/account value appears in Valkey keys, structured logs, metrics, or scanner output.

No database migration is added. Rollback is an application rollback: stop writers, return all replicas to the previous compatible revision together, and verify `/health/ready`. Expiring counter keys may be left to TTL or removed by namespace after the old application is stable; deleting them reduces throttling and is not required for schema compatibility. A rollback to a local-only limiter weakens multi-replica abuse controls and requires explicit operational approval.

User interfaces should present 429/503 status without stealing focus, retain user-entered content when safe, expose retry timing in text, and keep all retry controls keyboard-operable. The current development client already exposes request errors as alerts; product flows must not implement silent automatic retry loops.
