CREATE TABLE moderation_restrictions (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  kind varchar(16) NOT NULL CHECK (kind IN ('timeout')),
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  request_fingerprint char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (expires_at > created_at),
  UNIQUE (actor_id, community_id, idempotency_key)
);

CREATE INDEX moderation_restrictions_effective_idx
  ON moderation_restrictions(community_id, target_account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE moderation_audit_events (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  target_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  target_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  action varchar(64) NOT NULL,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  reason varchar(500),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  previous_hash char(64),
  event_hash char(64) NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}',
  CHECK (octet_length(metadata::text) <= 4096)
);

CREATE INDEX moderation_audit_community_order_idx
  ON moderation_audit_events(community_id, occurred_at DESC, id DESC);
