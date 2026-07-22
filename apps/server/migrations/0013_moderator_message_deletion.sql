CREATE TABLE moderation_message_evidence (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  body_snapshot varchar(4000) NOT NULL,
  content_hash char(64) NOT NULL,
  captured_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  UNIQUE (message_id)
);

CREATE TABLE moderation_message_deletions (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL REFERENCES moderation_message_evidence(id) ON DELETE RESTRICT,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  request_fingerprint char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (actor_id, message_id, idempotency_key)
);

CREATE INDEX moderation_message_deletions_community_idx
  ON moderation_message_deletions(community_id, created_at DESC, id DESC);
