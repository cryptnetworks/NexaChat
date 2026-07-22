# Real-time capacity and soak testing

`npm run test:realtime-capacity` starts two loopback API instances, authenticates
60 WebSocket clients, creates three subscriptions per client, and fans out a
warmup plus 100 measured events. It records connection and delivery latency,
logical deliveries per second, subscriptions, process CPU, peak resident memory,
and the server send-queue depth and bytes. It then reconnects half the clients
as a bounded storm and verifies delivery after recovery.

The local profile deliberately duplicates every coordination publication. The
server must preserve event identity and each client must receive each event only
once. The same run injects publisher failure, confirms delivery remains local
without crossing instances, restores publication, and verifies cross-instance
delivery. Separate probes reject a slow consumer with close code 1013 and prove
that a failed subscriber enters degraded mode without preventing local delivery.
All reports omit tokens, account and resource identifiers, endpoints, payloads,
and provider errors.

Set `NEXA_RT_VALKEY_URL` and run `npm run test:realtime-capacity:valkey` to repeat
the two-instance profile against Valkey. The command fails closed when Valkey is
absent or its subscriber cannot become ready. Use an isolated namespace and a
non-production Valkey service; the adapter namespace is random and no durable
application state is written.

## Release soak profile

`npm run test:realtime-soak` requires Valkey and runs the checked-in ten-minute
profile: 1,000 connections, eight subscriptions each, 6,000 paced events, and a
500-connection reconnect storm. The result includes the exact OS, architecture,
Node version, CPU, memory, workload, thresholds, timestamps, coordination mode,
and machine-readable pass/fail reasons. Save it with
`--output=<evidence.json>` or `NEXA_RT_RESULT_PATH` on a dedicated, otherwise
idle release runner.

Bounded environment overrides are available for investigative runs:
`NEXA_RT_CONNECTIONS` (2–5,000), `NEXA_RT_SUBSCRIPTIONS` (1–32),
`NEXA_RT_WARMUP_EVENTS` (1–1,000), `NEXA_RT_EVENTS` (10–100,000), and
`NEXA_RT_RECONNECT_CONNECTIONS` (1–connection count). The soak duration can be
extended to one hour with `NEXA_RT_SOAK_SECONDS` but cannot be shortened below
600 seconds. An override changes the workload and cannot replace evidence from
the checked-in release profile.

For infrastructure failure recovery, run the soak through a test-only network
fault proxy, interrupt Valkey after warmup, restore it before the recovery
phase, and retain both this report and redacted Valkey/host telemetry. Measure
host CPU, memory, network, Valkey clients and pub/sub output buffers alongside
the in-process metrics. A single-host result is not a production capacity claim;
repeat on the supported deployment topology and investigate any queue growth,
missing delivery, duplicate delivery, reconnect rejection, or threshold breach.
