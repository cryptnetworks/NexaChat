# Security threat model

Last reviewed: 2026-07-22

This model describes the implemented NexaChat web, server, desktop, persistence,
coordination, deployment, and build boundaries. It is a security contract, not a
claim that roadmap features already exist. The companion
[attachment threat model](attachment-threat-model.md) remains authoritative for
attachments, which are not connected to product upload or download routes.

## System and data flow

```text
browser or bundled desktop webview
             |
          HTTPS/WSS
             |
optional Cloudflare Tunnel -> nginx edge -> Fastify HTTP/WebSocket server
                                           |       |        |
                              auth/domain/authz  Valkey   web-push providers
                                           |
                                      PostgreSQL
                                           |
                                backup/export workers

private S3-compatible object storage is provisioned and has an adapter, but no
message attachment flow may use it until issues #83, #84, and #85 are complete.
```

The supported production topology is one Docker host. Only the nginx edge
publishes a host port. PostgreSQL, Valkey, object storage, application metrics,
and the server process remain on private Compose networks. Cloudflare Tunnel is
an optional outbound transport and does not replace application authentication
or authorization.

## Security objectives

- Keep account credentials, sessions, private messages, direct conversations,
  reports, moderation evidence, notification endpoints, exports, audit history,
  legal holds, and backups confidential to their authorized scope.
- Make membership, role, moderation, administration, retention, and ownership
  decisions authoritative on the server.
- Preserve stable identifiers, idempotency, deterministic ordering, tombstones,
  audit integrity, and retry-safe outcomes across HTTP, WebSocket, jobs, restarts,
  and multiple instances.
- Bound request bytes, content, pagination, connections, subscriptions, queues,
  retries, cache keys, metrics labels, logs, and background work.
- Fail closed for authentication, authorization, sensitive rate limiting,
  moderation restrictions, and unavailable private resources.
- Minimize personal data in logs, metrics, notifications, storage keys, build
  evidence, and administrative output.

Availability is bounded by the documented single-host failure domain. End-to-end
encryption, federation, public attachment sharing, account recovery, and MFA are
not current security properties.

## Assets and actors

Protected assets include password hashes, session-token digests and native
session material, community and direct-message content, edits and tombstones,
membership and role state, timeouts and bans, reports and appeals, notification
subscriptions, read state, saved messages, exports, retention policy, legal
holds, audit chains, database and provider credentials, object bytes, backup
keys, build inputs, dependency locks, and release evidence.

Relevant actors are anonymous clients, authenticated members, blocked or removed
members, moderators, community owners, instance administrators, host and
database operators, storage and coordination operators, repository maintainers,
workflow runners, dependency and notification providers, and attackers who
control a browser profile, network endpoint, account, dependency, or one runtime
process. A host or database administrator remains a privileged trust anchor;
cryptographic audit chains make replacement detectable only when checkpoints are
stored independently.

## STRIDE summary

| Category               | Principal threats                                                                                              | Implemented controls                                                                                                                                                | Residual concern                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Credential stuffing, stolen sessions, forged proxy addresses, cross-origin WebSocket use                       | Argon2id password hashing, random revocable sessions stored as digests, strict cookies, exact origins, canonical trusted-proxy parsing, layered rate limits         | No MFA or recovery identity channel; tracked by #35 and #187-#189                                                 |
| Tampering              | Cross-scope mutation, replay, partial jobs, event alteration, migration drift                                  | Scoped server authorization, bounded schemas, idempotency keys, database constraints, transactional writes, event identifiers, migration checksums, audit hashes    | Permission reads and writes need one database transaction; #203                                                   |
| Repudiation            | Denied administrative action, altered moderation history, missing correlation                                  | Stable correlation identifiers, structured outcome events, append-only audit records and checkpoints                                                                | A privileged database operator can replace database data and checkpoints together unless checkpoints are exported |
| Information disclosure | IDOR, stale search results, private-resource probing, unsafe links, logs, push payloads                        | Current authorization at lookup/render, non-disclosing errors, React encoding, safe link schemes, redaction, private metrics, generic notification copy             | One database principal has broader capability than the application requires; #202                                 |
| Denial of service      | Oversized input, connection storms, slow consumers, fan-out pressure, cache growth, retry storms               | Body and schema limits, route/account/address limits, pending WebSocket reservations, subscription and queue caps, backpressure, TTLs, timeouts, jittered reconnect | The production profile has a single host and finite local fallback capacity                                       |
| Elevation of privilege | Missing service checks, cross-community role use, stale membership, protected-role moderation, CI write misuse | Deny-by-default scoped evaluation, community-filtered roles, sole-owner and protected-role rules, committed timeout/ban checks, read-only pull-request workflows    | Default-branch and secret protections require repository configuration; #206                                      |

## Trust-boundary contracts

Each boundary below records the implemented entry point, identity, authorization,
validation, output, resource control, audit, failure, retention, and primary abuse
cases. Visibility in a client is never authorization.

### 1. Browser and web application

- **Entry points:** the React application uses same-origin `fetch`, the
  `/v1/realtime` WebSocket, browser notification APIs, and internal navigation.
- **Identity source:** the browser presents the server-issued HTTP-only session
  cookie. JavaScript does not read the session token.
- **Authorization:** route guards improve navigation but every data operation is
  reauthorized by the server. Browser state and hidden controls grant no access.
- **Input validation:** forms provide usability constraints; shared server
  schemas remain authoritative. Drafts and synchronized preferences are parsed
  before use. Untrusted URLs accept only reviewed HTTP, HTTPS, or same-origin
  application destinations.
- **Output protection:** React text rendering performs contextual encoding. The
  application does not use raw HTML rendering for messages. External links use
  safe schemes and `noopener noreferrer`; unsafe search or discovery links are
  rendered without navigation.
- **Resource controls:** server limits apply to every request and socket. Client
  fetching cancels obsolete requests and bounds retries and cache lifetime.
- **Audit and telemetry:** the browser does not emit private content to a third
  party. Server requests receive a bounded correlation identifier.
- **Failure behavior:** unauthenticated routes return to the sign-in boundary;
  offline, stale, empty, retry, and global recovery states do not reveal private
  resources.
- **Retention:** account-and-space drafts and selected non-secret preferences use
  browser storage and synchronize across tabs. Drafts clear only after a
  successful send and otherwise remain until the user or browser profile clears
  them. Server sessions remain cookie-bound.
- **Abuse cases:** stored or DOM script injection, CSRF, unsafe links, cache
  leakage, cross-account draft confusion, and notification probing. CSP, exact
  origins, mutation headers, safe rendering, scoped storage keys, and server
  reauthorization reduce these risks. A compromised browser profile can read
  local drafts and display data.

### 2. Desktop native shell and webview

- **Entry points:** one bundled Tauri webview, nine explicitly registered
  credential and notification commands, and reviewed HTTP/HTTPS external-link
  handoff.
- **Identity source:** the operating-system user and credential service protect
  native records; the server session remains the application identity. The
  current web flow does not expose stored native tokens back to JavaScript.
- **Authorization:** only the bundled `main` webview receives the command surface.
  Production top-level navigation is restricted to Tauri application origins;
  debug additionally permits exact `http://localhost:5173`.
- **Input validation:** Rust and TypeScript independently bound command schemas,
  origin, account ID, labels, token length, expiration, operation IDs, delivery
  text, and deep links. New webviews, file URLs, script URLs, user information,
  arbitrary paths, and shell selection are denied.
- **Output protection:** native errors are stable codes. Credential commands can
  list metadata but cannot return a session token to JavaScript. URLs and
  provider errors are not logged.
- **Resource controls:** credential storage has 20 fixed slots and 2 KiB records;
  notification copy and deep links are bounded. Single-instance and in-process
  locks serialize access.
- **Audit and telemetry:** native operations avoid secret-bearing logs. Server
  notification checkpoints remain the delivery record.
- **Failure behavior:** locked, missing, denied, corrupt, or unsupported credential
  services fail with bounded non-disclosing states. Partial deletion is retryable
  and successful deletions remain deleted.
- **Retention:** valid remembered sessions remain in macOS Keychain, Windows
  Credential Manager, or a Secret Service-compatible Linux store until expiry or
  explicit deletion. No file, environment, argument, or browser-storage fallback
  is allowed.
- **Abuse cases:** hostile navigation, IPC confusion, arbitrary process launch,
  command-line injection, keychain denial, notification spoofing, and malicious
  deep links. The minimized capability set, URL allowlist, empty frontend
  capability permissions, no shell plugin, and safe checkpointed notifications
  are the primary controls. A compromised operating system or native process can
  inspect process memory.

### 3. HTTPS edge and reverse-proxy boundary

- **Entry points:** nginx receives public HTTPS and WSS traffic; the optional
  tunnel reaches the same private edge service.
- **Identity source:** TLS authenticates the configured public origin. Client
  identity is established only by the application session, not by a forwarding
  header.
- **Authorization:** nginx routes bounded application paths but does not decide
  community or resource access.
- **Input validation:** the edge rejects malformed requests, bounds body and
  header handling, and overwrites forwarded-address headers. The server trusts
  only the configured edge `/32` in the single-host profile.
- **Output protection:** production headers include a restrictive CSP, HSTS,
  no-sniff, referrer, permissions, and frame protections compatible with the web
  application and WebSocket endpoint.
- **Resource controls:** connection, request, body, timeout, worker, file,
  process, memory, CPU, and log rotation limits are explicit.
- **Audit and telemetry:** the safe access record contains method, status, byte
  count, and duration, not query strings, client addresses, cookies, or content.
- **Failure behavior:** upstream failure returns generic edge errors. Readiness,
  not liveness, controls application availability. TLS configuration fails at
  startup rather than falling back to plaintext public service.
- **Retention:** local container logs rotate within the documented bounds;
  certificate and edge configuration live in operator-controlled files.
- **Abuse cases:** forged proxy headers, request smuggling, slow clients, host
  confusion, certificate substitution, and metrics exposure. One public port,
  fixed networks, exact origin and proxy configuration, and private metrics are
  required deployment invariants.

### 4. HTTP API, authentication, and administration

- **Entry points:** Fastify routes under `/v1`, authentication routes, health
  endpoints, and private metrics. Mutations use JSON contracts; arbitrary file
  upload is absent.
- **Identity source:** local login verifies a normalized account name and
  Argon2id hash. Sessions use 32 random bytes; only a SHA-256 digest is persisted.
  Production uses a bounded `__Host-` Secure, HTTP-only, SameSite=Strict cookie.
- **Authorization:** each protected route authenticates actor claims before
  domain use. The scoped authorization service evaluates current account,
  membership, role, suspension, timeout, ban, protected-role, and resource state.
  Sensitive administration requires explicit instance permissions and recent
  authentication where implemented.
- **Input validation:** Fastify bounds the body before route parsing. Zod schemas
  bound identifiers, strings, reasons, metadata, arrays, pagination, and unknown
  shapes. Database values do not become dynamic SQL identifiers. Browser
  mutations require the exact trusted origin and `x-nexa-csrf: 1`.
- **Output protection:** stable public error codes omit stack traces, SQL details,
  internal paths, and private-resource existence. Search and discovery links are
  converted only to safe same-origin destinations.
- **Resource controls:** every non-health request consumes route and canonical
  address limits; authenticated routes additionally consume account limits.
  Auth, invite, discovery, administrative export, and other expensive paths have
  narrower bounded limits and deterministic retry information.
- **Audit and telemetry:** authentication, authorization, moderation,
  administration, export, and lifecycle actions record bounded outcomes and
  correlations without credentials or private content.
- **Failure behavior:** authentication and authorization fail closed. Sensitive
  distributed limiters fail closed when coordination is unavailable; generic
  responses do not distinguish a missing private resource from a denied one.
- **Retention:** sessions, notifications, read state, messages, moderation data,
  jobs, exports, tombstones, and audit events follow their database retention and
  legal-hold policies. Health responses contain only status.
- **Abuse cases:** credential stuffing, enumeration, CSRF, mass assignment,
  cross-community identifiers, stale roles, reason amplification, export abuse,
  and malformed or oversized input. Uniform errors, scoped lookups, bounded
  schemas, current-state checks, rate limits, and audit events are required.
  Password reset and verification delivery are not implemented.

### 5. WebSocket and real-time boundary

- **Entry points:** HTTP upgrade at `/v1/realtime`, then versioned client frames
  for heartbeat, subscriptions, and supported real-time commands.
- **Identity source:** upgrade verifies the same revocable session cookie, exact
  trusted origin, and canonical client address as HTTP.
- **Authorization:** space subscriptions revalidate current membership and
  moderation restrictions. Active subscriptions are rechecked on relevant
  events and periodic boundaries; HTTP remains the reconciliation authority.
- **Input validation:** versioned shared schemas bound frame bytes, identifiers,
  sequence values, and subscription counts. Malformed, unsupported, and oversized
  frames receive stable close behavior without private detail.
- **Output protection:** events preserve committed event identity and scoped
  payloads. A client receives events only for authorized subscriptions.
- **Resource controls:** pending upgrades reserve global, address, and account
  capacity before asynchronous verification. Connection, message-rate,
  subscription, queue-byte, heartbeat, verification-timeout, and sequence-cache
  limits are bounded. Slow consumers are closed.
- **Audit and telemetry:** connection, denial, message, queue, and fan-out metrics
  use bounded labels and omit session or content values.
- **Failure behavior:** expired or revoked sessions and lost authorization close
  or deny access. Valkey subscriber reconnect uses bounded jitter and no offline
  command queue. Duplicate events are ignored by stable identity; clients
  reconcile over HTTP after reconnect or degraded fan-out.
- **Retention:** connection and sequence state are bounded in memory and removed
  when inactive. Durable message, notification, unread, and event state belongs
  to PostgreSQL, not the socket process.
- **Abuse cases:** unauthorized subscription, reconnect storms, slow consumers,
  high-cardinality sequences, duplicate fan-out, stale permission access, and
  pending-upgrade races. Admission reservations, current authorization,
  deduplication, backpressure, and bounded caches are the controls.

### 6. Domain and authorization boundary

- **Entry points:** authenticated HTTP handlers, WebSocket commands, and bounded
  background jobs call domain services; adapters do not call around them.
- **Identity source:** an authenticated account ID and explicit scope set are
  carried into permission evaluation and audited commands.
- **Authorization:** deny-by-default permission rules filter role definitions and
  assignments by community and role scope. Sole-owner and protected equal-or-
  higher-role invariants apply to moderation and membership changes. Committed
  timeout and ban records are checked even when the production gateway is active.
- **Input validation:** domain methods enforce invariants again after transport
  parsing, including idempotency fingerprints, content policy, limits, ordering,
  and valid state transitions.
- **Output protection:** domain errors are stable codes. Private reports,
  evidence, blocks, appeals, and unavailable source messages are not returned to
  unauthorized actors.
- **Resource controls:** pagination, batch size, content, reasons, metadata,
  mentions, reactions, retries, and job attempts are bounded.
- **Audit and telemetry:** sensitive actions retain actor, target, scope, reason,
  timing, outcome, and correlation using bounded metadata.
- **Failure behavior:** transactions roll back partial writes; idempotent retries
  return the original committed result or a stable conflict. Superseding and
  expiry behavior is deterministic.
- **Retention:** policy inheritance, legal holds, tombstones, reports, appeals,
  evidence, and audit exclusions are represented in persistent state.
- **Abuse cases:** confused deputy calls, stale roles, permission loss during a
  mutation, duplicate messages, mention amplification, protected-role actions,
  and report abuse. Issue #203 tracks binding permission revalidation to the same
  PostgreSQL transaction as every sensitive mutation.

### 7. PostgreSQL boundary

- **Entry points:** parameterized adapter queries, forward-only migrations,
  backup and restoration commands, and authorized administrative maintenance.
- **Identity source:** a configured database URL or secret file authenticates the
  process. Production remote connections require TLS; the exact private service
  name is the documented single-host exception.
- **Authorization:** application queries include scope predicates and the service
  layer authorizes their use. Database foreign keys, unique constraints, checks,
  versions, and append-only triggers provide defense in depth. Issue #202 tracks
  separating owner, migrator, application, and backup roles.
- **Input validation:** queries use parameters. Migration filenames, order,
  checksums, and schema compatibility are verified; concurrent migration uses an
  advisory lock.
- **Output protection:** adapter errors are translated before public response.
  Connection strings, SQL text with values, and provider details are redacted.
- **Resource controls:** pool size, connection and statement timeouts, transaction
  duration, pagination, migration locks, retention batches, jobs, and backup age
  are bounded and configuration validated.
- **Audit and telemetry:** readiness, pool pressure, migration state, job outcome,
  audit-chain checkpoints, and backup outcome are observable without row data.
- **Failure behavior:** a required database failure removes readiness. Transactions
  roll back, migrations stop on checksum or ordering mismatch, and jobs recover
  leases after restart without duplicating committed effects.
- **Retention:** PostgreSQL is authoritative for messages, edits, tombstones,
  memberships, notifications, read state, moderation, exports, holds, audit, and
  job state. Scheduled deletion is batched, retryable, dry-runnable where
  documented, and subordinate to legal holds and audit exclusions.
- **Abuse cases:** SQL injection, cross-tenant predicate omission, privilege
  overreach, pool exhaustion, unsafe migration, race conditions, backup leakage,
  and privileged audit replacement. Parameterization, service authorization,
  constraints, checksums, redaction, encryption, and independent audit
  checkpoints are the controls.

### 8. Valkey coordination boundary

- **Entry points:** atomic rate-limit scripts, short-lived coordination keys, and
  cross-instance publish/subscribe event fan-out.
- **Identity source:** the configured password authenticates the server. Remote
  production requires TLS; plaintext is allowed only to the exact private
  single-host service.
- **Authorization:** Valkey is not an authentication or authorization authority.
  Every delivered event is rechecked at the application boundary.
- **Input validation:** connection schemes, namespace, key components, value
  size, TTL, timeouts, and event envelopes are validated. Raw user identities are
  digested before use in rate-limit keys.
- **Output protection:** public errors do not expose keys, endpoints, passwords,
  or provider text. Event identity is preserved across instances.
- **Resource controls:** key TTLs, namespaces, command deadlines, reconnect
  backoff, circuit behavior, subscriber buffers, rate-window cardinality, and
  payload bytes are bounded. Atomic scripts prevent replica races.
- **Audit and telemetry:** backend outcome, latency, limiter scope, reconnect,
  duplicate, queue, and degradation metrics use fixed labels.
- **Failure behavior:** sensitive limits fail closed. Ordinary traffic may use a
  bounded local limiter that cannot grant authorization. Subscriber failure
  degrades live delivery, reconnects with jitter, and never queues arbitrary
  commands offline; durable HTTP state remains available for reconciliation.
- **Retention:** rate and coordination state expires. Valkey does not own durable
  message, session, authorization, unread, or audit truth.
- **Abuse cases:** forged addresses, session churn, endpoint aliases, unbounded
  keys, replay, cache poisoning, duplicate events, reconnect storms, and password
  exposure. Canonical addresses, route normalization, digested namespaced keys,
  atomic scripts, TTLs, deduplication, and private networking are required.

### 9. Object storage and attachment boundary

- **Entry points:** a private S3-compatible adapter supports bounded put, get,
  head, and delete operations for provider integration tests. No product upload,
  preview, signed download, or message attachment route currently calls it.
- **Identity source:** bucket-scoped S3 credentials are read from secret files.
  Remote endpoints require HTTPS; the exact private service is the single-host
  exception.
- **Authorization:** object storage never decides user access. A future route must
  authorize current message and membership state before every operation.
- **Input validation:** bucket, endpoint, object key, bytes, checksums, timeouts,
  and response metadata are bounded. Keys are opaque and cannot contain paths or
  user metadata.
- **Output protection:** the bucket is private and provider errors, URLs,
  credentials, keys, and bytes are excluded from logs. No browser delivery policy
  exists until isolated download is implemented.
- **Resource controls:** request bytes, operation timeout, retry count, and object
  identifiers are bounded. The future attachment contract adds quotas, scan
  queues, archive limits, range controls, and cleanup batches.
- **Audit and telemetry:** adapter operation codes, coarse byte classes, latency,
  and failure state are permitted; filenames, content, digest fingerprints, and
  endpoints are not.
- **Failure behavior:** startup verifies the private bucket. Provider timeout,
  partial write, duplicate job, and restart recovery are tested at the adapter
  boundary; unavailable bytes never become an available attachment.
- **Retention:** object lifecycle is not a substitute for application retention.
  Attachment retention, quarantine, legal holds, tombstones, orphan cleanup, and
  backup behavior remain blocked on #83-#85.
- **Abuse cases:** guessed keys, cross-community reference swaps, path traversal,
  MIME confusion, active content, malware, archive bombs, metadata leakage,
  quota races, and orphan bytes. The detailed attachment threat model is a
  mandatory gate and explicitly forbids partial unscanned delivery.

### 10. Web-push provider boundary

- **Entry points:** explicit subscription registration and revocation, followed
  by background delivery to operator-allowlisted HTTPS push endpoints.
- **Identity source:** the authenticated account owns the subscription; VAPID
  server keys authenticate delivery to the provider.
- **Authorization:** notification preferences, muted scopes, blocks, membership,
  resource deletion, and current delivery eligibility are evaluated before send.
- **Input validation:** endpoint scheme and allowlisted DNS host or suffix, keys,
  subscription ID, payload, attempts, and provider timeout are bounded. Rich-link
  preview fetching is not performed.
- **Output protection:** push copy omits message text and private community
  details and uses safe application routes. Provider responses and subscription
  secrets are redacted.
- **Resource controls:** per-account subscription count, delivery payload, job
  attempts, timeout, retry age, notification aggregation, and queue depth are
  bounded.
- **Audit and telemetry:** stable delivery outcomes and coarse latency are
  recorded without endpoint, encryption key, message content, or recipient
  identity labels.
- **Failure behavior:** transient failures retry within a bounded age; permanent
  invalidation revokes the endpoint. Provider outage never changes notification
  read state or authorization.
- **Retention:** subscriptions are revocable and notification records follow
  retention. Delivery jobs expire and clean up complete or terminal state.
- **Abuse cases:** server-side request forgery, notification spam, private content
  leakage, stale resource deep links, blocked-user delivery, and endpoint probing.
  Public-endpoint validation, privacy-safe payloads, preferences, rate limits,
  and server authorization are required.

### 11. Observability, audit, and administrative evidence

- **Entry points:** structured server events, Prometheus metrics, community and
  instance audit browsing, integrity checkpoints, and bounded exports.
- **Identity source:** request correlation and authenticated actor IDs are used
  internally; operator access to private metrics and retained logs is external to
  the application.
- **Authorization:** audit browsing, evidence access, legal holds, reports, and
  exports require scoped permissions. The production edge returns 404 for
  `/metrics`.
- **Input validation:** event names, attributes, labels, filters, cursors, date
  ranges, export rows, and metadata are allowlisted and bounded.
- **Output protection:** redaction rejects identifiers, addresses, credentials,
  content, paths, URLs, queries, and high-cardinality values from metrics and
  routine logs. Administrative views minimize private fields.
- **Resource controls:** label sets, value length, filter breadth, pagination,
  export size, artifact retention, and local log rotation are bounded.
- **Audit and telemetry:** append-only community audit events form SHA-256 chains
  with independently exportable checkpoints. Security outcomes retain stable
  codes and correlations.
- **Failure behavior:** telemetry failure cannot grant access or alter the user
  result. Invalid audit chains and stale writes are explicit failures; debug
  provider payloads are not substituted into public output.
- **Retention:** logs, metrics, reports, evidence, legal holds, audit events, and
  exports use separate documented policies. Audit and hold records are excluded
  from ordinary message deletion.
- **Abuse cases:** log injection, metric-cardinality exhaustion, private filter
  probing, report disclosure, export amplification, evidence deletion, and
  privileged chain replacement. Allowlisted fields, stable pagination,
  redaction, limits, append-only enforcement, and external checkpoints reduce
  these risks.

### 12. Background jobs, exports, deletion, and backup

- **Entry points:** durable job records drive retention, export, deletion,
  notification, and recovery work; operator backup and restore scripts act on
  database and provider volumes.
- **Identity source:** jobs retain the initiating actor and correlation or run as
  an explicitly documented system principal. Backup access uses file-backed
  operator secrets.
- **Authorization:** enqueue revalidates the requester and workers revalidate
  current eligibility before releasing private output. Legal holds and
  cancellation boundaries remain authoritative.
- **Input validation:** job type, schema version, metadata, batch, attempt,
  deadline, destination, artifact name, manifest, checksum, and restore schema
  range are bounded and validated.
- **Output protection:** exports are encrypted, expiring, revocable, integrity
  manifested, and never combine another account private data through shared
  resources. Backups and logs do not print credentials or private rows.
- **Resource controls:** queue depth, leases, batch size, retry and backoff,
  artifact size, retention, cleanup, restore deadline, and concurrent jobs are
  bounded.
- **Audit and telemetry:** initiation, progress class, completion, revocation,
  cancellation, cleanup, restore, and failure retain stable outcome and
  correlation without private payloads.
- **Failure behavior:** leases recover after restart, committed work is not
  repeated, partial artifacts are removed, and cancellation cannot interrupt an
  unsafe commit boundary. Restore is performed in an isolated disposable target
  before use.
- **Retention:** job metadata, artifacts, backups, tombstones, holds, and audit
  evidence have distinct expiries. A restore must preserve deleted or restricted
  state and replay cleanup.
- **Abuse cases:** duplicate or poisoned jobs, stale authority, unauthorized
  export, cancellation races, partial writes, backup disclosure, rollback to an
  incompatible schema, and resurrection after deletion. Durable idempotency,
  checksums, encryption, holds, version gates, cleanup, and restore tests are the
  controls.

### 13. Cloudflare Tunnel boundary

- **Entry points:** two outbound `cloudflared` instances can connect the private
  edge to the configured public hostname.
- **Identity source:** a file-backed tunnel token authenticates each connector.
  It is not a NexaChat account identity.
- **Authorization:** the tunnel transports traffic only. Application sessions,
  CSRF, origin checks, scopes, and rate limits remain mandatory.
- **Input validation:** configuration pins the client image, validates the public
  URL and private origin, disables host publication, and preserves WebSocket
  transport. The nginx edge still overwrites forwarded headers.
- **Output protection:** origin TLS and the edge security headers remain in
  effect. Token values and tunnel diagnostics are excluded from repository and
  routine logs.
- **Resource controls:** two bounded connectors, health checks, restart policy,
  resource limits, and private metrics prevent an unconstrained helper process.
- **Audit and telemetry:** tunnel health and generic connection outcomes may be
  observed privately; tokens, hostnames beyond configured inventory, client
  addresses, and URLs are not application metric labels.
- **Failure behavior:** tunnel loss removes external reachability but does not
  expose a plaintext or provider port. Direct single-host HTTPS remains a
  separately configured deployment option.
- **Retention:** the token remains in an operator-controlled secret file and is
  rotated according to the credential guide. Connector logs rotate.
- **Abuse cases:** stolen tunnel token, host-header confusion, forwarded-address
  spoofing, metrics exposure, or treating provider access policy as application
  authorization. File secrets, exact origins, private networks, fixed proxy
  trust, and server-side authorization are required.

### 14. Repository, CI, build, and release boundary

- **Entry points:** pull requests, default-branch pushes, schedules, manual
  release-candidate jobs, dependency input, container registries, and wiki
  publication.
- **Identity source:** repository accounts and workflow tokens identify changes
  and jobs. Release signing identities are separate and are not configured by
  ordinary verification jobs.
- **Authorization:** pull-request workflows have read-only contents and no
  secrets. No `pull_request_target` or write-capable untrusted-code path is used.
  The bounded wiki publisher is the documented permission exception.
- **Input validation:** action revisions and images are immutable, dependency
  locks require approved registries and integrity, migrations are ordered,
  workflow permissions and interpolation are policy checked, and artifact
  manifests bind commit, lock, platform, architecture, and checksums.
- **Output protection:** scanner output is redacted; artifacts use intentional
  names and retention. Build provenance is evidence, not a claim of release
  signing. Fork jobs receive no production secret.
- **Resource controls:** job timeouts, concurrency cancellation, artifact
  retention, scanner limits, build targets, and scheduled full-image scans are
  bounded.
- **Audit and telemetry:** verification artifacts tie results to exact commits.
  Dependency, license, static, secret, SBOM, provenance, migration, and build
  gates have explicit blocking behavior.
- **Failure behavior:** missing evidence and HIGH or CRITICAL unsuppressed findings
  fail the relevant gate. Upload steps do not conceal an earlier evidence
  failure. Release and deployment are separate authorized operations.
- **Retention:** source reports, image reports, SBOMs, and provenance are retained
  for 30 days by current workflow policy; release evidence follows the release
  guide.
- **Abuse cases:** dependency substitution, mutable actions or images, lifecycle
  scripts, poisoned caches, write tokens on untrusted code, artifact confusion,
  secret leakage, and bypassed checks. Immutable pins, lock-based installs,
  ignored install scripts, least privilege, provenance checks, and separated
  release operations are required. Issue #206 tracks default-branch rules and
  repository secret controls that are not currently enabled.

## User-generated content flows

### Messages, mentions, reactions, threads, and search

The client submits a bounded schema and idempotency key. The domain service
authenticates and authorizes the actor, then the PostgreSQL transaction locks the
idempotency key, re-reads mutable message and membership state, commits one
message and stable event identity, and only then fans out the event. Mentions,
reactions, replies, unread state, notifications, and search results refer to
stable records and preserve safe tombstones. Current authorization is applied
at query and rendering; a missing or inaccessible private result is not
distinguished publicly. Valkey duplication affects delivery, not durable truth.

### Reports, moderation, and audit evidence

Reports and evidence references are private to authorized moderation roles.
Timeouts, bans, protected-role checks, sole ownership, moderator deletion,
cases, appeals, blocks, reasons, and audit outcomes are server-side state.
Deletion returns a tombstone rather than deleted content, and retention or legal
hold governs evidence cleanup. Public errors do not reveal whether a private
report or target exists.

### Notifications and presence

Notification records, read state, preferences, mutes, blocks, and source state
are durable and account-scoped. Browser and desktop delivery uses generic copy
and safe routes. Presence is expiring, rate-limited availability state rather
than a precise activity history. A disconnected or expired heartbeat cannot be
used as proof that a person is absent.

### Drafts and saved messages

Drafts are account-and-space scoped browser data, synchronized across tabs and
cleared after successful send. They are not encrypted against the local browser
profile. Saved-message records are private to their owner; a deleted or newly
inaccessible source is rendered as unavailable without leaking its prior text.

## Residual-risk register

| ID    | Severity      | Status                   | Risk and required treatment                                                                                                                                                     |
| ----- | ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TM-01 | Medium        | Open, #203               | Permission revalidation and mutation writes can use different PostgreSQL transaction contexts. Bind them to one transaction with deterministic concurrency tests.               |
| TM-02 | Medium        | Open, #202               | Production database bootstrap, migration, application, and backup use one principal. Introduce separate least-privilege roles and upgrade tests.                                |
| TM-03 | Medium        | Open, #206               | Default-branch rulesets and repository secret controls are not enabled. Require review, checks, restricted bypass, secret scanning, and push protection.                        |
| TM-04 | Low           | Accepted with disclosure | Browser storage protects draft scope but not a compromised browser profile. Keep drafts free of credentials and clear them on explicit account removal.                         |
| TM-05 | Low           | Operational limitation   | The supported production Compose profile has one host and one failure domain. Backups and restore evidence protect recovery, not continuous availability.                       |
| TM-06 | Informational | Blocked on #83-#85       | The private object adapter is not an attachment feature. Do not ship upload or download until quarantine, scanning, isolated delivery, retention, and cleanup are complete.     |
| TM-07 | Informational | Open, #35 and #187-#189  | Recovery and verification are not implemented. Do not add reset tokens or delivery channels outside the reviewed design.                                                        |
| TM-08 | Low           | Platform trust           | Desktop keyrings reduce persistence exposure but cannot protect secrets from a compromised operating system or native process. Require platform evidence before support claims. |

No unresolved critical or high-severity vulnerability was identified in the
2026-07-22 review. A new finding at that level must use private vulnerability
reporting until a coordinated fix is ready; it must also block release readiness.

## Review triggers

Update this model whenever a change adds an endpoint, authentication method,
permission, attachment flow, integration, public origin, native command,
provider, cache use, database credential, background job, build permission,
release channel, federation path, encryption claim, or data-retention category.
The reviewer must update boundary tests, the residual-risk register, operations
documentation, and failure behavior in the same change.
