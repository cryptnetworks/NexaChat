# Initial threat model

## Assets and boundaries

Protected assets include credentials, sessions, private messages, attachments, membership data, moderation evidence, audit history, and encryption keys. Trust boundaries exist at clients, reverse proxies, the application, PostgreSQL, Valkey, object storage, email/media providers, and installed extensions.

## Priority threats and controls

- Account takeover: memory-hard password hashing, revocable rotated sessions, MFA, recovery controls, and recent-authentication gates.
- Authorization bypass and privilege escalation: service-boundary checks, deny-by-default evaluation, transactional role changes, and decision-table tests.
- Spam and resource exhaustion: layered account/IP/resource limits, quotas, bounded payloads, and backpressure.
- Content and attachment abuse: the required quarantine, scanning, authorization,
  isolated-delivery, metadata, retention, recovery, and residual-risk controls are
  specified in [Attachment threat model](attachment-threat-model.md). Attachment
  upload/download is not yet implemented and must not ship partially.
- Cross-site attacks: secure same-site cookies, CSRF protection, strict origin checks, output encoding, and content security policy.
- Data exposure: log redaction, least-privilege credentials, scoped object URLs, encryption in transit, backups with equivalent protections, and deletion workflows.
- Audit tampering or premature retention: versioned administrative events and checkpoints use database-enforced append-only community chains and verifiable SHA-256 hashes. Legal holds are append-only directives. Operators export checkpoints independently to detect privileged replacement of both database evidence tables.
- Extension compromise: administrator approval, explicit permission scopes, isolated execution, network/secret denial by default, and revocation.

Local accounts use memory-hard password hashing, protected revocable session tokens, strict browser-cookie settings, origin/CSRF checks, bounded authentication attempts, and credential-version invalidation. HTTP abuse controls use atomic expiring Valkey counters by bounded route, canonical address, community, and verified account; keys contain digests rather than raw identities. Sensitive routes fail closed when enabled coordination is unavailable, while ordinary traffic can use a bounded local fallback that never grants authorization. WebSocket upgrades revalidate the same revocable session and trusted origin, and shared Valkey admission is applied before local connection/message limits. End-to-end encryption, federation, and peer-to-peer operation are not current properties.

## Federation research prerequisites

Research must define global identity and key rotation, server trust, cross-instance authorization, moderation jurisdiction, abuse reporting, metadata leakage, delivery while offline, consistency and conflict rules, NAT traversal, media relay, retention conflicts, and compromised-instance containment before implementation.
