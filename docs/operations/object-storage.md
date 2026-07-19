# Private object storage

`@nexa/object-storage` is the provider-neutral boundary for private attachment bytes. The initial adapter speaks the S3-compatible API and is verified during startup when `NEXA_OBJECT_STORAGE_ENABLED=true`. Attachment application flows are not connected, so current PostgreSQL-backed flows can start in an explicitly degraded state when the optional adapter is unavailable.

The adapter is deliberately not an HTTP delivery layer. Callers must authorize the current account and attachment state before choosing an opaque object key; keys, credentials, provider errors, and presigned/public URLs must never cross the transport boundary. Attachment initiation, scanning, state transitions, and delivery remain out of scope for this adapter.

## Configuration and startup

Set the `S3_*` values and the bounded `NEXA_OBJECT_STORAGE_*` values documented in `.env.example`. Production requires an HTTPS endpoint, disables automatic bucket creation, and refuses to start if creation is enabled. Startup verifies that the bucket exists and conservatively rejects any bucket policy because safely proving arbitrary policies private is provider-specific. Provider failures emit only the stable `object_storage.degraded` event and `object_storage_unavailable` code; endpoints, credentials, keys, and provider details are excluded.

Local development may create the configured bucket. The Compose MinIO credentials match `.env.example`; enable the adapter only when MinIO is running.

## Integrity, cleanup, and recovery

Writes store a SHA-256 digest in private object metadata. Reads verify both that digest and the declared byte length, and reject oversized or altered objects with `integrity_failure`. Operations use a bounded timeout and one SDK attempt so retries remain owned by the calling job. Prefix cleanup lists at most the configured page size and deletes only returned opaque keys; callers must persist progress and repeat bounded pages.

If startup or runtime verification fails, check endpoint reachability,
credentials, bucket existence, and bucket policy without logging secrets.
Restore a private bucket and remove any bucket policy; bounded readiness probes
observe recovery without requiring an application restart. Object storage will
be authoritative durable data for attachment flows and must be encrypted, backed
up consistently with PostgreSQL attachment metadata, and restore-tested before
those flows are enabled. Its readiness role must be reviewed when attachment
flows become active. See the [observability guide](observability.md) for the
current optional-degradation semantics.
