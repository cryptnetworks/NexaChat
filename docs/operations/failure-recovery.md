# Attachment and background-job failure recovery

Attachment delivery remains disabled until the complete quarantine, scanning,
authorization, and download state machine in the attachment threat model is
implemented. The storage and worker foundations nevertheless fail safely under
the failures an eventual attachment pipeline must survive.

## Immutable object writes

The private S3 adapter writes with `If-None-Match: *`. A retry after an ambiguous
timeout therefore cannot overwrite an object. If the key already exists, the
adapter reads it through the bounded integrity path and succeeds only when byte
length, server SHA-256 metadata, calculated digest, and content type all match.
A different retry is `integrity_failure`; an unavailable verification remains
`object_unavailable`. Deletes are idempotent, and prefix cleanup is bounded to a
configured page so a caller can persist a checkpoint between pages.

Object keys must be opaque and stable for one immutable logical object. A job
must never choose a new key merely because the response to a prior write was
lost. Neither keys nor digests, filenames, payloads, credentials, endpoints, or
provider errors belong in ordinary logs and metrics.

## Durable worker contract

Migration 41 extends `background_jobs` with a bounded JSON checkpoint, stable
availability time, lease owner/token/expiry, and a small allowlisted error code.
`PostgresJobRecoveryStore` claims one deterministically ordered row with
`FOR UPDATE SKIP LOCKED`; expired leases are reclaimable, duplicate claimers are
idle, and an exhausted abandoned final attempt becomes terminal. A restart
preserves attempts and checkpoints. Interrupted cancellation is finalized
without invoking the handler again.

`RecoverableJobWorker` accepts only allowlisted job kinds and bounded timing
configuration. Each claim has an unguessable lease token. Checkpoints are at
most 32 primitive fields and 4 KiB, use optimistic versions, and extend the
lease. Completion, retry, failure, and cancellation require the current lease
and version. Handler failures and timeouts use deterministic exponential backoff
with bounded jitter; retry exhaustion is terminal. Late work after a timeout
cannot checkpoint or settle a reassigned job. External effects must still be
idempotent, as the object-store contract demonstrates.

Metrics use only checked-in job kind and outcome labels. Store failures expose
`job_store_unavailable`; handler text, payload ciphertext, checkpoints, URLs,
and database diagnostics are not returned or logged by the worker.

## Fault matrix and operator recovery

Run `npm run test:resilience` for deterministic injected failures. It covers an
object-store timeout after commit, immutable retry, mismatched retry, altered
read, storage/listing outage, partial external effect, network response loss,
checkpoint resume after a worker restart, concurrent duplicate claims,
execution timeout, bounded retry exhaustion, cooperative and interrupted
cancellation, and redacted database failure.

With disposable PostgreSQL and MinIO available, set `DATABASE_TEST_URL` and
`OBJECT_STORAGE_TEST_URL`, then run `npm run test:resilience:integration`. The
PostgreSQL test applies the exact migrations and proves checkpoints survive a
new worker instance; the object-store test writes, verifies, reads, and deletes
real private bytes. Interrupt the test-only network between each operation for
release evidence, then rerun after recovery. Never fault a production bucket or
database.

On an outage, stop claiming new work, preserve database rows and immutable
objects, restore the dependency, verify readiness and scanner health, and allow
expired leases to be reclaimed. Do not edit attempts or checkpoints manually.
An authorized operator may retry only a terminal job whose maximum permits it,
using the existing recent-authenticated, audited job control. Queue depth,
oldest age, retry/exhaustion counts, dependency readiness, cleanup lag, and
coarsely bucketed bytes are the bounded health signals.
