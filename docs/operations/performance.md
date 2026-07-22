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
