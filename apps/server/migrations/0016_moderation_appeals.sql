CREATE TABLE moderation_appeals (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  appellant_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  restriction_id uuid NOT NULL UNIQUE REFERENCES moderation_restrictions(id) ON DELETE RESTRICT,
  statement varchar(2000) NOT NULL CHECK (length(btrim(statement)) BETWEEN 1 AND 2000),
  status varchar(16) NOT NULL CHECK (status IN ('submitted','upheld','overturned')),
  reviewer_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  decision_reason varchar(2000),
  idempotency_key varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (appellant_id,idempotency_key)
);

CREATE INDEX moderation_appeals_queue_idx
  ON moderation_appeals(community_id,status,created_at,id);
