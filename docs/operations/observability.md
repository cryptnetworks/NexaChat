# Production observability

NexaChat exposes structured application logs, Prometheus-compatible metrics,
W3C trace context, and separate liveness, startup, and readiness probes. These
signals are for operating the service, not for user analytics. They must never
contain credentials, cookies, authorization headers, session or invitation
tokens, message text, attachment bytes, object keys, or raw account and resource
identifiers.

Telemetry is deliberately non-authoritative. A metrics, trace, or log-export
failure must not change an authentication, authorization, persistence, or event
delivery result. Monitor `nexa_telemetry_failures_total` and
`nexa_telemetry_dropped_series_total` because either indicates reduced operator
visibility.

## Configuration

`NEXA_LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error` and defaults to
`info`. Production logs are newline-delimited JSON. Local JSON can be filtered
with `jq` without changing the production schema.

`NEXA_TRACE_SAMPLE_RATE` accepts a number from `0` through `1`. A value of `0`
does not sample newly created traces, `0.01` samples approximately one percent,
and `1` samples every new local trace. The default is `0.01` in production and
`1` in development and test. `.env.example` makes the development value
explicit. Sampling changes volume, not the redaction policy; review telemetry
capacity and access controls before increasing it in production.

The metrics endpoint is always `/metrics`. It has no application-level
authentication and must be reachable only from the internal monitoring network
or an authenticated ingress. Do not expose it directly to the internet.

## Structured event catalog

Use the `event` field for automation. Human-readable messages and additional
safe fields may evolve additively. The stable baseline is:

| Event                      | Severity      | Meaning                                                                                            |
| -------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `configuration.invalid`    | error         | Startup configuration was rejected before listening.                                               |
| `migration.applied`        | info          | One reviewed PostgreSQL migration was applied.                                                     |
| `migration.complete`       | info          | The standalone migration command completed.                                                        |
| `migration.failed`         | error         | PostgreSQL startup or migration validation failed.                                                 |
| `coordination.degraded`    | warn          | Enabled Valkey coordination was unavailable; authoritative behavior remains in PostgreSQL.         |
| `object_storage.degraded`  | warn          | Enabled object storage was unavailable; current non-attachment application flows remain available. |
| `startup.ready`            | info          | Required initialization completed and the service is ready.                                        |
| `startup.failed`           | error         | Startup failed with a stable, non-disclosing code.                                                 |
| `http.request.started`     | info          | A request entered the bounded HTTP lifecycle.                                                      |
| `http.request.completed`   | info          | A request completed with safe route, status, and duration fields.                                  |
| `http.request.aborted`     | warn          | A client disconnected before its bounded HTTP request completed.                                   |
| `http.request.rejected`    | warn or error | A known client/security rejection, or an unexpected server failure.                                |
| `dependency.state_changed` | info or warn  | A fixed dependency entered an `ok`, `degraded`, or `disabled` state.                               |
| `dependency.close_forced`  | warn          | A dependency client required a bounded local force-close after graceful close failed.              |
| `trace.span.completed`     | info          | A sampled, allowlisted HTTP, message, PostgreSQL, or realtime span completed.                      |
| `shutdown.signal`          | info          | The first supported process signal requested shutdown.                                             |
| `shutdown.started`         | info          | The process stopped accepting new application work and began draining.                             |
| `shutdown.resource_closed` | info          | One bounded shutdown resource closed.                                                              |
| `shutdown.resource_failed` | warn          | A named bounded shutdown resource could not close; exception text is excluded.                     |
| `shutdown.completed`       | info          | All shutdown work completed within the configured deadline.                                        |
| `shutdown.failed`          | error         | A close operation failed or the shutdown deadline expired.                                         |
| `postgres.pool.error`      | error         | An idle PostgreSQL client failed; only the fixed `pool_error` code is retained.                    |

Request events include a server-generated `correlationId`. When a valid trace
context exists, they also include `traceId`. HTTP method, registered route
template, status class or code, duration, safe error type, and stable public code
are permitted. Raw URLs, query values, request/response bodies, network
addresses, usernames, display names, error messages, stacks, and provider
objects are not permitted.

A client disconnect before response completion emits one
`http.request.aborted` warning with synthetic status `499`; aggregate HTTP
metrics count it in the `4xx` class and the request span ends as a failure. The
synthetic status is operational metadata only and is never sent as an HTTP
response.

Authentication and authorization failures are intentionally non-disclosing.
Logs and metrics can show an aggregate failure or deny outcome, but must not show
whether an account or private resource exists.

## Metrics and cardinality

`GET /metrics` returns Prometheus text exposition. Scrape every 15 to 30 seconds
for a typical deployment. The principal series are:

- `nexa_http_requests_total`, `nexa_http_request_duration_seconds`, and
  `nexa_http_active_requests` for traffic, latency, status class, and in-flight
  work;
- `nexa_authentication_failures_total` and
  `nexa_authorization_decisions_total` for privacy-safe aggregate security
  outcomes;
- `nexa_rate_limit_decisions_total` for bounded route/address/account/community
  scope, endpoint class, shared/local backend, and admission/degradation outcome;
- `nexa_audit_integrity_checks_total` for the fixed valid, invalid, and
  checkpoint-mismatch outcomes; either failure outcome pages immediately;
- `nexa_dependency_operations_total`,
  `nexa_dependency_operation_duration_seconds`, and
  `nexa_dependency_health`, plus `nexa_postgres_pool_connections` for
  PostgreSQL, Valkey coordination, and object-storage health and saturation;
- `nexa_websocket_events_total` and `nexa_websocket_state` for connection,
  subscription, stale-client, queue, and backpressure behavior, with
  `nexa_websocket_delivery_duration_seconds` for aggregate publication latency;
- `nexa_background_jobs` for job state; it is absent or zero while no
  background-job runner is configured;
- `nexa_process_memory_bytes`, `nexa_process_cpu_seconds_total`,
  `nexa_process_start_time_seconds`, `nexa_process_uptime_seconds`,
  `nexa_process_event_loop_lag_seconds`, and `nexa_process_lifecycle` for
  process health and lifecycle state;
- `nexa_trace_spans_total` and `nexa_trace_span_duration_seconds` for the fixed
  trace-operation catalog without trace or correlation identifiers; and
- `nexa_telemetry_failures_total` and
  `nexa_telemetry_dropped_series_total` for telemetry self-monitoring.

Metric labels are bounded by design. Methods, status classes, dependency names,
operations, outcomes, lifecycle states, and WebSocket reasons use fixed sets.
HTTP labels use registered route templates; UUID and numeric path components are
normalized, query strings are discarded, and malformed or unbounded routes
become `unmatched`. Each metric accepts at most 512 series, enough for the
reviewed route/status budget while retaining a hard memory bound. Additional
series are dropped and counted rather than consuming unbounded memory.

Never add account, community, space, message, request, session, token,
attachment, object-key, address, filename, or content values as labels. Trace
and correlation identifiers belong only in sampled traces and structured logs,
not metrics.

## Trace context

The API accepts the W3C `traceparent` header in the exact version-`00` form and
returns the active context in the response `traceparent` header. All-zero,
malformed, oversized, or unsupported contexts are ignored and replaced with a
new safe context. NexaChat does not accept arbitrary baggage as telemetry
attributes.

Every HTTP request receives a separate server-generated UUID correlation ID;
an inbound `X-Request-Id` is not trusted. The same correlation ID is returned in
`X-Request-Id`, error envelopes, and real-time event envelopes. Valid upstream
trace IDs can connect services without becoming authorization evidence,
idempotency keys, or metric labels.

Every local span is capped by `NEXA_TRACE_SAMPLE_RATE`. An upstream unsampled
decision remains unsampled; an upstream sampled decision is retained only when
the local sampler also selects it. This prevents an untrusted public client from
forcing unbounded trace logs while preserving trace lineage when sampling is
enabled.
Trace records are allowlisted to operation, outcome, duration, trace/span
lineage, and server-generated correlation identifiers. Registered routes and
status classes remain bounded metric or request-log fields. SQL text and values,
message or attachment content, identities, resource IDs, cookies, tokens,
provider endpoints, and exception text are excluded.

## Health semantics

All health responses set `Cache-Control: no-store` and contain bounded status
data only. They must never be treated as a dependency inventory or expose
credentials, endpoints, provider errors, private data, or arbitrary exception
text.

| Endpoint          | Success                                                                                                                           | Failure semantics                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/health/live`    | `200` while the process can serve its probe handler.                                                                              | It does not query PostgreSQL, Valkey, or object storage. A downstream outage must not make liveness fail.                         |
| `/health/startup` | `200` with `started` after required initialization and listener setup complete.                                                   | `503` with `starting` before startup completes. It is sticky after successful startup and is not a dependency-availability probe. |
| `/health/ready`   | `200` with `ready` when startup completed, the process is not draining, and PostgreSQL plus its migration history are compatible. | `503` with `unavailable` and `Retry-After: 5` when required storage/schema state is unhealthy or the process is draining.         |

PostgreSQL and compatible migration state are required. PostgreSQL loss keeps
liveness and startup successful but makes readiness unavailable. Readiness
recovers after PostgreSQL and compatible schema state recover; no application
restart is required.

Valkey coordination is optional and non-authoritative. Object storage is also
optional for the current application because attachment flows are not connected.
When either enabled optional dependency is unavailable, readiness stays `200`
but its status becomes `degraded`. Disabled optional adapters are not degraded.
Each readiness evaluation performs bounded optional probes, so the next
successful probe clears degradation after the dependency recovers. If a future
feature makes one of these adapters authoritative for a request class, its
readiness policy must be reviewed before that feature ships.

## Graceful shutdown

`SIGINT` and `SIGTERM` begin one idempotent drain. The process marks readiness
unavailable, rejects new non-health and non-metrics application work, stops new
WebSocket upgrades, notifies and drains active sockets, waits for bounded HTTP
work, and then closes PostgreSQL, object storage, and coordination clients.
Signal handlers are installed before dependency initialization, so cancellation
during startup also closes every resource initialized so far within the same
deadline.

The entire sequence is bounded by `NEXA_SERVER_SHUTDOWN_TIMEOUT_MS`, which
defaults to 10 seconds and accepts 1,000 through 60,000 milliseconds. WebSocket
draining remains separately bounded by `NEXA_WS_DRAIN_SECONDS`. Alert on every
`shutdown.failed`; repeated deadline failures usually indicate a stuck request,
socket, or dependency close path. Orchestrators should allow at least the server
shutdown deadline plus a small log-flush margin before sending an unconditional
kill.

## Dashboard baseline

Build small operator dashboards from aggregate signals only:

1. Service overview: lifecycle, readiness, request rate, in-flight requests,
   status-class rate, and p50/p95/p99 request duration.
2. Dependencies: operation rate and latency by fixed dependency/outcome plus
   PostgreSQL total, idle, and waiting pool connections.
3. Real-time delivery: open connections, subscriptions, connection rejection,
   stale disconnect, and slow-consumer/backpressure rates.
4. Runtime: resident and heap memory, CPU time rate, and event-loop lag.
5. Security aggregate: authentication failures, rate limiting, and authorization
   allow/deny ratio. Never break these panels down by identity or resource.
6. Telemetry health: failed telemetry operations and dropped metric series.

Vendor-specific dashboards are intentionally out of scope. Keep dashboard
queries in deployment configuration, not in application code.

## Suggested alerts

Tune thresholds against measured traffic and resource limits. Safe initial
signals are:

- critical: readiness is unavailable for 60 seconds, startup has not completed
  within the deployment's migration/startup budget, or any `shutdown.failed`
  event occurs;
- critical: HTTP 5xx exceeds 1% for 5 minutes with at least 100 requests, or p99
  duration exceeds 5 seconds for 10 minutes;
- warning: PostgreSQL waiting connections remain above zero, or idle connections
  remain zero, for 5 minutes;
- warning: an enabled optional dependency records degraded outcomes for 5
  minutes; escalate object storage before enabling attachment flows;
- warning: event-loop lag exceeds 100 milliseconds for 5 minutes, resident
  memory exceeds 80% of its container limit, or CPU consumption remains above
  80% of its allocation;
- warning: slow-consumer, stale-connection, or WebSocket rejection rates sharply
  exceed their established baseline;
- warning: rate-limit `limited`, `degraded`, or `dependency_failure` outcomes
  materially exceed baseline, without adding identity labels or exposing
  attempted identifiers; and
- warning: either telemetry failure or dropped-series counter increases.

Use a minimum event count with ratios so low-traffic instances do not page on a
single request. Alerts must link to this guide and identify the signal, not a
user, message, attachment, token, or private resource.

## Retention and access

Retention belongs to the deployment's security and compliance policy. A useful
starting point is 14 to 30 days for structured logs, 30 to 90 days for aggregate
metrics, and up to 7 days for sampled traces. Shorten retention when it is not
needed for an operational objective. Restrict access to operators, encrypt data
in transit and at rest, audit access where supported, and delete expired data.

Operational correlation and trace IDs are short-lived telemetry metadata. The
audit contract deliberately persists only the server-generated correlation ID
needed to connect a reviewed administrative action to separately retained
incident evidence; trace IDs are never audit fields. Do not join telemetry to
account profiles or use it for behavior tracking. PostgreSQL audit events and
external checkpoints remain authoritative for reviewed security events.

## Safe troubleshooting

Begin with health state, then bounded metrics, then filtered event logs. Never
enable request-body, header, SQL-value, provider-response, message-content, or
attachment-content logging to diagnose an outage.

```sh
curl --silent --show-error --include http://127.0.0.1:3000/health/live
curl --silent --show-error --include http://127.0.0.1:3000/health/startup
curl --silent --show-error --include http://127.0.0.1:3000/health/ready
curl --silent --show-error http://127.0.0.1:3000/metrics \
  | sed -n '1,120p'
```

Filter copied local JSON logs before sharing them:

```sh
jq -c 'select(.event == "http.request.rejected") | {event,correlationId,errorType,errorCode}' server.log
jq -c 'select(.event | startswith("shutdown."))' server.log
```

Do not paste an unreviewed `.env`, process environment, complete log file,
metrics scrape, trace export, database error, or `docker compose logs` output
into an issue. Search the material locally for credentials and seeded private
content first, and share only the minimum bounded fields needed to correlate the
failure.

## Local smoke checks

Run the development stack in one terminal:

```sh
npm run dev:up
```

Use another terminal for the health and metrics commands above. Check valid W3C
propagation with a synthetic trace that contains no production identifier:

```sh
curl --silent --show-error --dump-header - --output /dev/null \
  --header 'traceparent: 00-11111111111111111111111111111111-2222222222222222-01' \
  http://127.0.0.1:3000/health/live
```

The response should contain a `traceparent` with the same trace ID and a new span
ID. An invalid or all-zero header should instead produce a new trace ID.

Exercise optional degradation only against disposable local services. Set
`NEXA_COORDINATION_ENABLED=true` and `NEXA_OBJECT_STORAGE_ENABLED=true` in the
local `.env`, then restart the development process before running:

```sh
docker compose stop redis
curl --silent --show-error --include http://127.0.0.1:3000/health/ready
docker compose start redis
curl --silent --show-error --include http://127.0.0.1:3000/health/ready

docker compose stop object-storage
curl --silent --show-error --include http://127.0.0.1:3000/health/ready
docker compose start object-storage
curl --silent --show-error --include http://127.0.0.1:3000/health/ready
```

Both outages should retain HTTP 200 readiness with degraded status when the
corresponding adapter is enabled, then return to ready after recovery. The
current application has no background-job runner, so job gauges should remain
absent or zero.

The isolated required-dependency smoke test creates and removes only its named
Compose project and temporary volume:

```sh
npm run verify:clean-env
```

It proves empty-database migration, PostgreSQL readiness loss, liveness
independence, and automatic recovery. Press Ctrl-C in the foreground development
terminal to exercise graceful shutdown, then confirm `shutdown.started` and
`shutdown.completed` appear without `shutdown.failed` and that completion stays
within `NEXA_SERVER_SHUTDOWN_TIMEOUT_MS`.
