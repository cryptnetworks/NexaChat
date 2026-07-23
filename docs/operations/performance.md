# API performance budgets

NexaChat treats performance results as evidence only when the environment and
workload are explicit and repeated. `npm run test:performance` runs the bounded
single-process profile used for pull-request regression feedback. It warms each
workload, discards the warmup, and then records seven independent trials. A
trial contains hundreds of requests at the documented concurrency; a single
timing can never pass the policy.

`npm run test:performance:postgres` is the release-candidate profile. Set
`NEXA_PERF_DATABASE_URL` to an administrative connection for disposable test
databases. The harness creates a random `nexa_perf_*` database, applies the exact
repository migrations, seeds 2,500 messages, measures both the authorized HTTP
path and its indexed database query, and drops only that generated database.
It fails before reporting a result when PostgreSQL is absent. Never point the
harness at a credential that cannot create and drop disposable databases.

## Measurement contract

The checked-in policies in `tools/performance/api-budgets.ts` define the
environment, dataset, warmup count, measured sample count, trial count,
concurrency, p95 and p99 thresholds, p95 coefficient-of-variation threshold,
and allowed regression for every workload. Reports also record OS, architecture,
Node version, CPU model and count, memory, timestamps, and the PostgreSQL version
where applicable. They contain no database URL, credentials, actor identifiers,
message bodies, or internal paths.

Absolute budgets protect users on a cold new baseline. For longitudinal
regression checks, pass `--baseline=<report.json>` (or `NEXA_PERF_BASELINE`) and
`--output=<report.json>` (or `NEXA_PERF_RESULT_PATH`). A baseline is accepted
only when its schema, profile, and complete environment key match. The run fails
when median trial p95 regresses by more than 15%, even if it remains below the
absolute ceiling. It also fails on p95/p99 or variance breaches. Reviewers may
replace a baseline only with a documented workload or supported-environment
change; raising a threshold solely to hide a regression is not acceptable.

Shared CI machines introduce variance, so the in-memory profile is a regression
signal rather than a production capacity claim. Release evidence must include
the PostgreSQL profile on an otherwise idle, versioned runner, at least one
repeat after a failure, and an explanation for any variance or baseline change.
Capacity and soak testing are separate from these latency budgets.

## Server endurance and resource budgets

`npm run test:server-endurance` runs a five-second deterministic pull-request
profile after a bounded warmup. It records request latency at p50, p75, p90,
p95, p99, and maximum; throughput; errors; process CPU; event-loop delay;
garbage-collection pauses; RSS, heap, external, and array-buffer memory; and
post-run resource handles. The release profile runs for 60 seconds, while
`npm run test:server-endurance:soak` runs for at least 15 minutes and refuses a
shorter duration.

Peak RSS and post-recovery growth have separate ceilings. V8 can retain
committed heap pages after live objects are collected, so the gate also limits
the minimum live-heap growth observed in the final 20% of the run,
external-memory growth, and active-resource growth. The endpoint and peak stay
in the report, but an arbitrary garbage-collection sawtooth endpoint does not
become a false leak failure. A high retained RSS value is visible and bounded
without being mislabeled as a live-object leak. Longer release and soak
profiles are required to establish a memory-growth slope; the short
pull-request profile is only a ceiling and resource-cleanup regression signal.
Reported slopes exclude the first 20% of measured load so V8's initial heap
reservation does not masquerade as sustained growth. Runs shorter than 60
seconds report the timeline but deliberately omit a slope estimate.

These profiles use production server configuration with logging disabled, but
in-memory persistence. They are event-loop and application-allocation evidence,
not substitutes for the PostgreSQL profile, live Valkey capacity, or container
resource measurements. Every latency sample array is bounded. Environment
overrides reject unsafe connection, duration, and dataset sizes.

## Web bundle budgets

Run a production build before `npm run test:bundle-budget`. The gate measures
the built JavaScript, compressed JavaScript, CSS, total assets, largest chunk,
and chunk counts. The absolute envelope allows limited growth over the reviewed
baseline while a comparable saved baseline rejects an unexplained increase
above ten percent. The pull-request workflow runs this deterministic gate after
the existing production build; it does not add a noisy latency benchmark to
every pull request.

The manually dispatched release-candidate workflow records API, PostgreSQL,
server-endurance, bundle, local-realtime, and Valkey-realtime reports in its
existing compact evidence artifact. This reuses one already-required runner and
does not add a scheduled workflow to free-account Actions usage.

## Browser production workload

`npm run test:browser-performance` builds and serves the production web client,
then runs one warmup and five measured Chromium sessions. Network responses and
the WebSocket peer are deterministic local fixtures so the report isolates
client startup, rendering, validation, and state-management work. It records
cold and warm interface readiness, a 100-message history render, 100 realtime
insertions, 2,000 realtime updates, main-thread and layout work, long tasks,
DOM and listener counts, JavaScript heap change, and the maximum rendered
message count. The client keeps a 200-message live window; older history is
loaded through authorized backward cursor pages instead of retaining an
unbounded accessible DOM.

The command is retained for local and manual release evidence rather than the
pull-request workflow. Chromium installation and repeated browser timing are
both costly and noisy on shared hosted runners; the deterministic bundle gate
remains the fast per-pull-request client regression check.

For an explicit long-session stress comparison, `NEXA_BROWSER_INSERTED_MESSAGES`
may increase insertions through 50,000, `NEXA_BROWSER_UPDATE_CYCLES` may increase
updates from the default 20 through 200, and `NEXA_BROWSER_EVENT_BATCH_SIZE`
controls deterministic synthetic transport pacing from 1 through 512 events.
The default is 512, matching the client’s bounded pending-delivery queue. The
normal latency and memory budgets still apply, so a stress run that exceeds a
normal-user threshold remains a reported failure while its machine-readable
result is retained. Do not raise a budget merely to make a stress workload pass.

The implementation-backed baseline, objectives, bottleneck ranking, and
environment limitations are recorded in
[`performance-audit-2026-07-22.md`](performance-audit-2026-07-22.md).
