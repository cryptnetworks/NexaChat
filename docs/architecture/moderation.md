# Moderation safety model

Moderation commands are community scoped, idempotent, and re-evaluate permission,
membership, ownership, and role hierarchy inside the write path. The sole owner is
never an eligible target. Non-owner moderators may act only on strictly lower role
positions; missing or equal positions fail closed.

Reasons are normalized and limited to 500 characters. Audit records contain actor,
target, scope, action, outcome, correlation identifier, timing, and bounded metadata.
They form a per-community SHA-256 chain. Private reasons and future evidence are not
returned by ordinary community or message APIs.

Timeouts expire using server time and are checked by every authoritative community
permission decision. WebSocket subscriptions are periodically revalidated, so an
effective restriction removes existing subscriptions without a client restart.
Database indexes permit effective-restriction checks without scanning history.

Operational restoration must retain moderation records and audit history. Expired or
reversed restrictions remain immutable history; legal holds added to related evidence
take precedence over ordinary deletion or retention cleanup.
