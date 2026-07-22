# Private object storage

`@nexa/object-storage` is the provider-neutral boundary for private attachment bytes. The initial adapter speaks the S3-compatible API and is verified before the server opens a listener when `NEXA_OBJECT_STORAGE_ENABLED=true`.

The adapter is deliberately not an HTTP delivery layer. Callers must authorize the current account and attachment state before choosing an opaque object key; keys, credentials, provider errors, and presigned/public URLs must never cross the transport boundary. Attachment initiation, scanning, state transitions, and delivery remain out of scope for this adapter.

## Configuration and startup

Set the `S3_*` values and the bounded `NEXA_OBJECT_STORAGE_*` values documented in `.env.example`. Production requires an HTTPS endpoint, disables automatic bucket creation, and refuses to start if creation is enabled. Startup verifies that the bucket exists and conservatively rejects any bucket policy because safely proving arbitrary policies private is provider-specific. Provider failures emit only `object_storage.startup_failed` with the stable code `object_storage_unavailable`.

Local development may create the configured bucket. The Compose MinIO credentials match `.env.example`; enable the adapter only when MinIO is running.

## Integrity, cleanup, and recovery

Writes use a create-only condition and store a SHA-256 digest in private object metadata. An ambiguous retry succeeds only when the existing length, calculated digest, metadata digest, and content type match; it can never overwrite different bytes. Reads verify both the digest and declared byte length and reject oversized or altered objects with `integrity_failure`. Operations use a bounded timeout and one SDK attempt so retries remain owned by the calling job. Prefix cleanup lists at most the configured page size and deletes only returned opaque keys; callers must persist progress and repeat bounded pages. See the [failure-recovery runbook](failure-recovery.md).

If startup verification fails, check endpoint reachability, credentials, bucket existence, and bucket policy without logging secrets. Restore a private bucket, remove any bucket policy, then restart the server. Object storage is authoritative durable data and must be encrypted, backed up consistently with PostgreSQL attachment metadata, and restore-tested before attachment flows are enabled.
