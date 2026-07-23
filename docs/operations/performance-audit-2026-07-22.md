# Performance and scalability audit — 2026-07-22

## Status and baseline

This record establishes the measurement baseline before product optimization.
It does not claim release capacity or superiority over another client.

- Repository base: `docs/security-operations`
- Exact base commit: `b7ee786123d5073e127246c7d9931077a4780f5e`
- Host: Apple M4 Pro, 14 physical and logical cores, 24 GiB memory
- Operating system: macOS 27.0 arm64, Darwin 27.0.0
- Runtime: Node.js 24.18.0 and npm 11.16.0
- Build: production server and web artifacts
- Initial dataset: one account, community, text space, and 1,000 messages
- Initial API trials: three independent executions, each with seven measured
  trials after workload-specific warmup
- Initial realtime trials: three independent executions, each with 60
  connections, two instances, 180 subscriptions, 100 events, and 6,000 logical
  deliveries
- Initial browser trials: three independent executions, each with one warmup
  and five measured fresh Chromium 149 contexts against the production build
  and deterministic local protocol fixtures
- Server endurance: 60 seconds, 32 keep-alive connections, 2,500 seeded
  messages, and a 25/75 liveness-to-authorized-history request mix

The host was not quiet during the initial runs. The one-minute load average was
34.77 and the operating-system media analysis service used approximately three
CPU cores. Absolute latency stayed well below its budgets, but health-check p95
variance failed in all three API runs. Those runs are an honest noisy-host
baseline and are not qualifying release evidence.

## Performance objectives

The interaction targets below are user-experience guardrails. Sub-100 ms work
should feel immediate, sub-250 ms realtime delivery should preserve
conversation flow, and bounded one-to-five-second lifecycle operations should
provide timely visible feedback. Capacity targets require dedicated-runner
qualification before they become support claims.

| Area                        | Small deployment target         | Medium deployment target | Large deployment target | Qualification                  |
| --------------------------- | ------------------------------- | ------------------------ | ----------------------- | ------------------------------ |
| HTTP message page           | p95 75 ms, p99 125 ms           | p95 150 ms, p99 300 ms   | p95 250 ms, p99 500 ms  | PostgreSQL profile             |
| Authentication              | p95 250 ms, p99 750 ms          | p95 350 ms, p99 1 s      | p95 500 ms, p99 1.5 s   | Real Argon2id workload         |
| Search                      | p95 200 ms, p99 500 ms          | p95 350 ms, p99 750 ms   | p95 500 ms, p99 1 s     | Representative index           |
| Realtime delivery           | p95 250 ms, p99 500 ms          | p95 300 ms, p99 600 ms   | p95 500 ms, p99 1 s     | Cross-instance profile         |
| Message acknowledgement     | p95 250 ms, p99 500 ms          | p95 350 ms, p99 750 ms   | p95 500 ms, p99 1 s     | Durable write profile          |
| Event-loop delay            | p99 50 ms, max 100 ms           | p99 50 ms, max 100 ms    | p99 75 ms, max 150 ms   | Server endurance               |
| Error and timeout rate      | below 1%, no correctness errors | below 1%                 | below 1%                | Load and degradation suites    |
| Server startup/readiness    | 2 s                             | 3 s                      | 5 s                     | Required dependencies ready    |
| Graceful shutdown           | 5 s                             | 10 s                     | 15 s                    | Requests and sockets drained   |
| Web first render            | 1.5 s                           | 2 s                      | 3 s                     | Production build, warm network |
| Web interface readiness     | 2.5 s                           | 3 s                      | 4 s                     | Production build               |
| Channel-switch render       | p95 100 ms                      | p95 150 ms               | p95 250 ms              | Bounded first page             |
| Desktop visible/interactive | 2 s / 3 s                       | 3 s / 4 s                | 4 s / 5 s               | Native platform evidence       |
| Idle desktop CPU            | below 1% median                 | below 1%                 | below 2%                | Ten-minute idle window         |
| Idle desktop RSS            | below 300 MiB                   | below 350 MiB            | below 400 MiB           | Aggregate process tree         |
| Endurance memory growth     | below 64 MiB/30 min             | below 128 MiB/hour       | below 256 MiB/hour      | Post-warmup slope              |

Representative deployment profiles are small (2 cores, 4 GiB, up to 100
realtime connections), medium (4 cores, 8 GiB, up to 1,000 connections), and
large (8 or more cores, 16 GiB, up to 5,000 connections per replica). These are
test workloads, not published support limits.

## Initial baseline

Median values across three complete executions:

| Workload          |                         p50 |       p95 |       p99 |          Throughput |                             CPU |                          Memory | Result          |
| ----------------- | --------------------------: | --------: | --------: | ------------------: | ------------------------------: | ------------------------------: | --------------- |
| HTTP liveness     | trial-level detail retained | 0.4532 ms | 1.8953 ms |        39,309 req/s | process-scoped profile retained | process-scoped profile retained | variance failed |
| HTTP message page | trial-level detail retained | 4.5467 ms | 4.7037 ms |         2,017 req/s |                profile retained |                profile retained | passed          |
| Realtime fanout   |                    85.91 ms | 109.74 ms | 114.24 ms | 50,869 deliveries/s |             141.05% of one core |          208,060,416 B peak RSS | passed          |
| Server endurance  |                    18.47 ms |  21.89 ms |  25.01 ms |         1,689 req/s |             113.35% of one core |          448,970,752 B peak RSS | passed          |

Realtime connection p95 was 9.75 ms, reconnect p95 was 5.27 ms, and median
incremental RSS was 1,421,585 bytes per connection. All three runs rejected 112
injected duplicate events, produced no client duplicate, closed the controlled
slow consumer with code 1013, and recovered after fanout degradation.

The 60-second server run produced zero errors, 24.44 ms event-loop p99,
2.06 ms garbage-collection p99, 61.53 ms application readiness, 2.77 ms listen
time, and 0.56 ms shutdown. V8 reserved RSS early and then remained within a
narrow plateau. The steady-window RSS slope was 3,912,679 bytes/minute and heap
slope was -30,793,535 bytes/minute. Minimum heap in the final 20% was 70,884,048
bytes, 12,530,304 bytes above the 58,353,744-byte start and well below the
64 MiB limit. All 32 client sockets and the listener closed, with active
resources falling from 36 to 3. Endpoint heap and peak heap remain reported
separately rather than being hidden by the final window.

Median p95 across the three production Chromium executions was 52.22 ms for
cold local interface readiness, 32.18 ms for warm readiness, 105.76 ms for
rendering the 100-message history, 63.25 ms for 100 realtime insertions, and
751.37 ms for 2,000 realtime updates. The update phase retained 12,771,972
bytes of JavaScript heap at median p95, added no listeners, and recorded no long
tasks. DOM-counter growth was 31 nodes at p95 in every retained execution.

The production web build contains one 282.22 kB JavaScript asset (81.45 kB
gzip), one 4.48 kB CSS asset (1.63 kB gzip), and a 0.44 kB HTML entry. The
bundle gate uses byte-accurate values rather than these rounded build labels.

## Optimization result: shared realtime serialization

The first ranked bottleneck was addressed by validating each immutable
realtime delivery once, serializing it once, computing its encoded size once,
and reusing that representation for every local recipient. Per-connection open
state, buffered-byte limits, queue accounting, send completion, error handling,
and slow-consumer closure remain independent. Account-scoped fanout reuses the
same representation only after its existing message validation; cross-instance
space delivery still reauthorizes every local subscriber before disclosure.

The before and after results below are medians across three complete executions
of the same 60-connection, two-instance, 180-subscription, 100-event workload on
the baseline host. Each execution produced 6,000 logical deliveries and injected
duplicate cross-instance publication. No benchmark-only production behavior was
introduced.

| Measurement                    |        Baseline | Shared serialization | Change |
| ------------------------------ | --------------: | -------------------: | -----: |
| Delivery p50                   |        85.91 ms |             44.83 ms | -47.8% |
| Delivery p95                   |       109.74 ms |             56.15 ms | -48.8% |
| Delivery p99                   |       114.24 ms |             58.92 ms | -48.4% |
| Delivery throughput            | 50,869 events/s |      98,027 events/s | +92.7% |
| Single-core process CPU        |         141.05% |              139.74% |  -0.9% |
| Peak RSS                       |   208,060,416 B |        170,409,984 B | -18.1% |
| Incremental RSS per connection |     1,421,585 B |            757,760 B | -46.7% |
| Connection p95                 |         9.75 ms |              9.88 ms |  +1.2% |
| Reconnect p95                  |         5.27 ms |              5.28 ms |  +0.3% |

Baseline delivery p95 ranged from 109.23 to 110.10 ms with a 0.33%
coefficient of variation. The optimized result ranged from 55.35 to 67.86 ms
with a 9.57% coefficient of variation; even the slowest optimized execution
remained below the fastest baseline execution. Optimized throughput ranged from
81,058 to 99,464 deliveries/s. All executions produced zero client duplicate
deliveries, rejected 112 injected duplicates, recovered after reconnect and
fanout degradation, delivered locally during subscriber failure, and closed the
controlled slow consumer with code 1013.

The follow-up CPU profile no longer showed repeated per-recipient datetime and
union validation among its prominent self-samples. Socket writes and the shared
`sendSerialized` path remain visible, so recipient lookup and transport work are
the next realtime candidates. The change was retained because tail latency,
throughput, and memory all improved materially without an error, authorization,
or backpressure regression.

## Ranked bottleneck inventory

| Rank | Component                                 | Evidence                                                                                                                                                                                       | User/resource impact                                                                                                                    | Proposed remediation                                                                                                     | Risk        |
| ---: | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
|    1 | Realtime delivery serialization           | CPU profile samples include Zod datetime parsing, union parsing, `safeSend`, buffer sizing, and socket writes. `safeSend` validates and serializes the same delivery for every subscriber.     | CPU and allocation cost grows with recipients; 137–141% single-core CPU at 6,000 deliveries.                                            | Validate once, serialize once, and reuse immutable payload bytes while preserving per-socket bounds.                     | Medium      |
|    2 | Realtime recipient lookup                 | Every event scans every connection and then checks its subscription set.                                                                                                                       | Sparse channels scale with all instance connections instead of recipients.                                                              | Add and benchmark a bounded subscription index maintained on subscribe, unsubscribe, revalidation, and close.            | Medium      |
|    3 | Web realtime retention                    | Production Chromium retained 12.18 MiB at median p95 after 2,000 update events. Code review shows both the seen-event set and rendered message collection are unbounded for a connected space. | Long sessions continually retain event identifiers; new messages continually enlarge React state and the accessible DOM.                | Bound recent event identities and the live message window with deterministic eviction, reconciliation, and tests.        | Medium      |
|    4 | In-memory message access                  | Idempotency lookup, history lookup, and ordering scan the full message map. The API CPU profile is dominated by domain work and validation.                                                    | Development and deterministic benchmark setup become quadratic or `O(n log n)` as history grows; production PostgreSQL is not affected. | Add bounded secondary indexes only if a representative in-memory benchmark proves net value.                             | Medium      |
|    5 | API response validation and serialization | Message-page CPU profile samples are concentrated in domain mapping, Zod datetime/UUID validation, Fastify serialization, and garbage collection.                                              | Tail CPU cost rises with page size.                                                                                                     | Preserve validation; investigate compiled response serialization and avoid repeated validation only with contract tests. | Medium-high |
|    6 | Web realtime insertion                    | Every received message filters and sorts the current page, then formats dates during render. Chromium processed 2,000 updates in 751.37 ms at median p95 without long tasks.                   | Main-thread work grows with visible messages and event rate. Server pagination currently bounds only the initial page.                  | Benchmark a bounded ordered update helper before choosing memoization or virtualization.                                 | Medium      |
|    7 | Object storage buffering                  | The current adapter accepts and returns complete `Uint8Array` objects and hashes them synchronously. Product attachment routes are not implemented.                                            | A future large attachment path would retain full objects and consume event-loop CPU.                                                    | Design bounded streaming only with the attachment lifecycle and scanner contract.                                        | High        |
|    8 | Desktop native runtime                    | Rust/Cargo execution, platform startup, process-tree memory, packaging, and sleep/wake profiles are unavailable on this host.                                                                  | Desktop resource behavior is unknown.                                                                                                   | Resolve the desktop dependency release blocker and run native retained profiles on every supported platform.             | High        |

## Profiling findings

The realtime CPU profile contains direct samples in `safeSend`, Zod union and
datetime parsing, buffer byte-length calculation, socket writes, and garbage
collection. The API profile contains 150 and 68 direct samples in domain paths,
127 samples in Zod datetime-regex generation/validation, 40 garbage-collector
samples, 39 Fastify pre-serialization samples, and additional UUID, buffer, and
schema parsing samples. Raw profiles are retained as local audit evidence and
are intentionally not committed because they include machine paths and are too
large for normal source review.

No worker thread is justified by this baseline. The measured costs are short,
per-request validation, traversal, serialization, and I/O coordination. A
worker would add cloning and scheduling overhead without eliminating the
recipient or query work. Ordinary database, Valkey, socket, and storage I/O
remains asynchronous.

The browser trace showed no task at or above the long-task threshold during the
measured workload. Rendering is therefore not a worker candidate. The retained
event identifiers and messages require bounded state, not parallel execution;
moving their update path to a worker would duplicate data and leave the
retention defect intact.

## Verification and limitations

Before measurement, the unmodified graph passed formatting, lint, strict types,
522 tests with 31 intentional service-gated skips out of 553, six browser
accessibility tests, production server/web builds, architecture and contract
tests, explicit authentication/authorization/HTTP/WebSocket/storage/desktop
suites, release policies, and full and production npm audits with zero findings.

PostgreSQL query plans, live Valkey soak, live S3 transfer behavior, multi-
container scaling, multi-route browser navigation endurance, and native desktop
profiling still require their respective service or platform environments. The
local browser workload covers one text space with deterministic transport; it
does not qualify network or multi-community navigation behavior. Unavailable
checks must not be reported as passed from the in-process baseline.

A controlled Discord comparison was not run. No fair, ordinary signed-in
session with comparable visible data and cold/warm state was available, and the
review does not automate or inspect proprietary behavior. NexaChat's internal
reproducible objectives remain authoritative; no comparative claim is made.
