# Ephemeral coordination

`@nexa/coordination` owns provider-neutral, non-authoritative coordination primitives backed initially by Valkey. It supports namespaced expiring values, atomic set-if-absent and fixed-window increments, reads, and deletion. It is not authorization or durable persistence: callers must authorize independently, tolerate eviction, and keep authoritative state in PostgreSQL.

Enable startup verification with `NEXA_COORDINATION_ENABLED=true`. Production requires a `rediss:` URL. Configuration bounds connect/operation timeouts, values, TTLs, circuit thresholds, and recovery probes. Diagnostics expose only `coordination_unavailable`; URLs, values, keys, and provider errors are never logged. Because coordination is optional and non-authoritative, an unavailable enabled adapter reports degraded readiness while PostgreSQL-backed application flows remain ready.

Every write requires an expiry. Keys are restricted and receive the configured namespace. Provider operations have no adapter retries: idempotency and retry budgets remain explicit at the calling job. After the configured consecutive failures, the circuit rejects immediately until its reset interval; one operation then probes recovery and closes the circuit on success.

On startup or runtime degradation, verify reachability, TLS, credentials,
memory/eviction policy, and namespace ownership without logging their values.
Bounded readiness probes and adapter recovery attempts observe restoration without
requiring an application restart. Request limits use an atomic expiring
increment: credential, session, token, invitation, WebSocket, webhook, and administrative endpoints fail closed during an
enabled-provider outage, while ordinary endpoints use a bounded local fallback.
An outage must never grant access or lose authoritative data. The full policy is
in [the rate-limiting runbook](rate-limiting.md). Rollback disables the adapter;
callers must retain safe database-backed behavior. Run the opt-in real test with
`COORDINATION_TEST_URL=redis://127.0.0.1:6379 npm run test:coordination` and see
the [observability guide](observability.md) for degradation metrics and alerts.
