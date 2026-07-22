# Attachment threat model

## Status and security objective

Attachment upload, processing, and download are not implemented. SeaweedFS in the
development Compose file is an unconnected adapter target, not a supported file
service. This document is the minimum security contract for future work. A
partial path that stores, previews, or serves unscanned user bytes is forbidden.

The objective is to let an authorized community member share a bounded file
without turning NexaChat into a malware distributor, parser exploit surface,
cross-origin content host, metadata oracle, or unbounded storage service. No
scanner can prove a file safe; controls reduce exposure and preserve revocation.

## Assets, actors, and trust boundaries

Assets are private file bytes, original and normalized metadata, membership and
message associations, scan results, moderation evidence, encryption keys,
storage credentials, quotas, and audit history. PostgreSQL owns attachment
identity, state, authorization scope, retention timestamps, and object keys.
Object storage owns opaque bytes only and is never an authorization authority.

Actors include authorized members, malicious or compromised members, recipients,
moderators, instance administrators, malware-scanner operators, and attackers
with network or storage access. Boundaries exist at the browser/native client,
reverse proxy, API, quarantine bucket, scanner, clean bucket, PostgreSQL, and
download origin. Filenames, MIME declarations, file bytes, archives, scanner
output, and object-store callbacks are untrusted.

## Threats

- executable malware, documents with active content, polyglots, parser exploits,
  malicious fonts/media, and files crafted to exploit antivirus engines;
- archive bombs, recursive/nested archives, extreme compression ratios, huge
  dimensions/durations/page counts, and CPU/memory/disk exhaustion;
- MIME/extension confusion, content sniffing, inline script execution, and
  credential phishing through trusted-looking downloads;
- unauthorized upload/download, stale signed URLs, membership changes during a
  transfer, object-key guessing, cross-community reference swaps, and confused
  deputy access through storage APIs;
- filename, EXIF, document-author, GPS, device, thumbnail, and timing leakage;
- scanner outage, timeout, crash, stale signatures, false negatives/positives,
  duplicate callbacks, reordered jobs, and compromised scanner infrastructure;
- unlimited retention, orphan objects, quota races, deletion failure, backup
  resurrection, and moderation evidence destroyed too early;
- secrets/private content in logs, metrics, traces, queue payloads, or alerts.

## Lifecycle and authoritative states

The database state machine is:

`initiated -> uploading -> quarantined -> scanning -> available`

Terminal or restricted states are `rejected`, `failed`, `revoked`, `expired`,
and `deleted`. Transitions use optimistic versions and idempotency keys. An
object cannot skip quarantine/scanning. Only one committed transition may make a
specific content digest available. Late or duplicate callbacks for an older
version are ignored and audited.

1. Initiation reauthorizes membership and permission, reserves quota atomically,
   records bounded declared metadata, generates an opaque random object key, and
   returns a short-lived single-object upload capability.
2. Upload accepts a fixed maximum byte count and deadline into a private
   quarantine bucket. Multipart count, part size, concurrent uploads, and total
   per-account/community storage are bounded. Incomplete uploads expire.
3. Completion verifies actual length and a server-calculated digest, then queues
   exactly one bounded scan job. Client digests and MIME types are hints only.
4. Scanning reads from quarantine with a credential that cannot publish or read
   unrelated objects. It enforces signature freshness, time/CPU/memory/extracted
   byte/nesting limits, identifies content from bytes, and treats unsupported or
   ambiguous formats according to the instance deny policy.
5. A clean result is revalidated against current state and atomically promotes
   or copies immutable bytes to the private clean area before `available` is
   committed. Infected, suspicious, timeout, scanner error, or stale-signature
   results remain unavailable and transition to a non-disclosing restricted
   state. Quarantine bytes are later deleted by bounded cleanup.
6. Download reauthorizes the current account against the current message,
   community membership, attachment state, and moderation policy on every
   request. UI visibility and possession of an identifier are never authority.
7. Revocation/expiry immediately blocks new download grants. Deletion records a
   tombstone first, removes clean/quarantine objects asynchronously and
   idempotently, releases quota once, then records completion.

## Upload, scan, and failure semantics

Limits must be explicit configuration with safe upper bounds and startup
validation. The implementation must bound file bytes, metadata/filename length,
active uploads, multipart parts, per-principal and per-community quotas, scan
queue depth, attempts, exponential backoff, total processing age, extracted
content, archive depth/count, media dimensions/duration, and cleanup batch size.

Backpressure rejects initiation with a stable retryable `attachment_busy`; quota
exhaustion is a stable non-retryable `attachment_quota_exceeded`. Invalid input
is `invalid_attachment`. Missing, unauthorized, quarantined, rejected, revoked,
expired, and deleted downloads all return the same non-disclosing
`attachment_unavailable`. Scanner dependency failure never fails open. Jobs use
bounded retries with jitter and a terminal `failed` state; operators can retry
only after dependency/signature health is restored, creating a new attempt with
the same immutable quarantined bytes and version checks.

No scanner result is trusted solely because it arrived on an internal network.
Callbacks require authenticated transport, expected job/object/digest/version,
bounded payload schemas, replay protection, and allowlisted stable result codes.
Scanner text and stack traces are never returned to users or logged verbatim.

## Isolated download and preview policy

The application never exposes bucket credentials, predictable keys, or a public
bucket. A download is either streamed through an authorization-enforcing service
or granted with a single-object, single-method URL lasting at most minutes. URLs
must not appear in messages, referrers, analytics, or logs and cannot be reused
after expiry. Range requests, bandwidth, concurrent downloads, and response time
are bounded; authorization is rechecked before creating each grant.

Downloads use a separate origin with no application cookies, no ambient auth,
no service workers, a restrictive CSP/sandbox, `X-Content-Type-Options: nosniff`,
`Content-Disposition: attachment` with a safely encoded generic fallback name,
and conservative `Content-Type: application/octet-stream` unless a reviewed safe
type policy says otherwise. Active formats are never rendered inline. Previews
are separately generated, scanned derivative objects; the original file is
never passed directly to browser parsers merely because scanning returned clean.

## Metadata and privacy

Store only normalized display filename, detected media type, byte length,
server digest, owner/scope identifiers, lifecycle timestamps, and security/audit
fields required for operation. Object keys contain no account, community,
filename, MIME, or time information. Strip path components, controls, bidi
overrides, invisible spoofing characters, and unsafe length from display names;
preserve an optional original name only if product need and retention are
explicitly approved.

Future image/video/document derivatives remove EXIF, GPS, author, device,
thumbnail, and hidden document metadata. The UI must warn that originals may
contain personal metadata when originals remain downloadable. Logs/metrics use
attachment/job IDs, state/result codes, sizes in coarse buckets, latency, and
queue depth—never filenames, URLs, digests usable as content fingerprints,
file bytes, scanner text, storage credentials, or message content.

## Retention, moderation, and cleanup

Instance policy defines bounded retention separately for incomplete uploads,
quarantine failures, available attachments, moderation holds, tombstones, audit
events, and backups. Message deletion or retention expiry schedules attachment
deletion unless an authorized, time-bounded legal/moderation hold applies. Hold
creation/removal is privileged and audited; ordinary users cannot discover a
hold. Backup retention and restore procedures must not silently resurrect access:
restored rows retain restricted/deleted states and cleanup is replayed.

A reconciler compares database state with both buckets using bounded pages and
age thresholds. It deletes orphaned/incomplete objects, retries missing deletes,
flags database rows whose bytes are missing, and emits counts/ages without
metadata. Cleanup is idempotent and rate-limited. Object lifecycle rules are
defense in depth, not the sole deletion mechanism.

## Authorization, audit, and operations

Initiate, complete, retry, download, revoke, hold, and delete commands enforce
deny-by-default permissions at the service boundary and revalidate sensitive
state at transaction commit. Moderators do not automatically receive file bytes;
their inspection permission is explicit, scoped, recent-auth gated, and audited.
Storage/scanner identities are least privilege and separate for quarantine,
promotion, download, and cleanup. Credentials rotate without making buckets
public; recovery restores the prior credential until replacement is verified.

Audit stable codes for actor, action, attachment, scope, prior/new state,
correlation ID, and outcome. Do not audit sensitive filenames/content. Alert on
queue age/depth, scanner health/signature age, failure/rejection rates, quota
pressure, cleanup lag, missing/orphan objects, and unusual download volume.

## Verification required before implementation can ship

- state-machine unit tests for every allowed/forbidden/duplicate/stale transition;
- authorization matrices including removed/suspended members, private scopes,
  moderators, cross-community swaps, revoked/expired/deleted files, and URL replay;
- boundary tests for bytes, names, MIME mismatch, quotas, concurrency, multipart,
  archives, extraction, dimensions, timeouts, queue saturation, and range requests;
- integration tests with scanner clean/infected/suspicious/error/timeout/stale
  signatures, callback forgery/replay/reordering, storage outage, partial copy,
  deletion failure, and recovery without availability leaks;
- response tests for non-disclosing errors, attachment-only delivery headers,
  cookie-free isolated origin, URL TTL/scope/method, and safe filename encoding;
- privacy tests proving metadata stripping and secret/content absence from logs;
- cleanup/reconciliation/backup-restore tests proving tombstones remain denied;
- load tests proving queue, memory, disk, connection, bandwidth, and worker bounds;
- keyboard/screen-reader flows for upload progress, scanning, failure, retry,
  available, unavailable, removal, and clear safety/metadata warnings.

## Residual risk and non-goals

Signatures lag novel malware; allowed files may exploit recipients or persuade
them to run unsafe content; metadata stripping can be incomplete; encrypted or
unsupported archives cannot be inspected; administrators/storage/scanner hosts
remain privileged compromise targets; authorized recipients can redistribute
bytes; deletion cannot recall prior downloads and persists until backup expiry.

Scanning is not content moderation, data-loss prevention, copyright enforcement,
or proof of safety. End-to-end encrypted attachments cannot use server-side
scanning without changing the trust model and require a separate threat model.
Federated, extension-provided, external-provider, inline active-content, and
public-link attachment delivery are out of scope until separately reviewed.
