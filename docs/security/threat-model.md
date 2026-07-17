# Initial threat model

## Assets and boundaries

Protected assets include credentials, sessions, private messages, attachments, membership data, moderation evidence, audit history, and encryption keys. Trust boundaries exist at clients, reverse proxies, the application, PostgreSQL, Valkey, object storage, email/media providers, and installed extensions.

## Priority threats and controls

- Account takeover: memory-hard password hashing, revocable rotated sessions, MFA, recovery controls, and recent-authentication gates.
- Authorization bypass and privilege escalation: service-boundary checks, deny-by-default evaluation, transactional role changes, and decision-table tests.
- Spam and resource exhaustion: layered account/IP/resource limits, quotas, bounded payloads, and backpressure.
- Content and attachment abuse: size/type validation, isolated object storage, malware-scanning hook, safe download headers, and report workflows.
- Cross-site attacks: secure same-site cookies, CSRF protection, strict origin checks, output encoding, and content security policy.
- Data exposure: log redaction, least-privilege credentials, scoped object URLs, encryption in transit, backups with equivalent protections, and deletion workflows.
- Audit tampering: append-only events with chained hashes and externally checkpointed digests; this is planned, not implemented.
- Extension compromise: administrator approval, explicit permission scopes, isolated execution, network/secret denial by default, and revocation.

The development slice stores state in memory and has no real authentication. It must never be exposed to untrusted networks. End-to-end encryption, federation, and peer-to-peer operation are not current properties.

## Federation research prerequisites

Research must define global identity and key rotation, server trust, cross-instance authorization, moderation jurisdiction, abuse reporting, metadata leakage, delivery while offline, consistency and conflict rules, NAT traversal, media relay, retention conflicts, and compromised-instance containment before implementation.
