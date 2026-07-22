CREATE TABLE safety_reports (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  reporter_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  target_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  target_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  category varchar(32) NOT NULL CHECK (category IN ('spam','harassment','threat','self_harm','other')),
  description varchar(1000) NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  evidence_reference_ids uuid[] NOT NULL DEFAULT '{}',
  status varchar(16) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','triaged','actioned','dismissed')),
  request_fingerprint char(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((target_account_id IS NOT NULL)::integer + (target_message_id IS NOT NULL)::integer = 1),
  CHECK (cardinality(evidence_reference_ids) <= 10),
  UNIQUE (reporter_id, community_id, idempotency_key)
);

CREATE INDEX safety_reports_queue_idx
  ON safety_reports(community_id, status, created_at, id);
CREATE INDEX safety_reports_reporter_idx
  ON safety_reports(reporter_id, created_at DESC, id DESC);
