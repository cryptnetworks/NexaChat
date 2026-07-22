CREATE TABLE moderation_cases (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  report_id uuid NOT NULL UNIQUE REFERENCES safety_reports(id) ON DELETE RESTRICT,
  assignee_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL CHECK (status IN ('open','investigating','resolved','closed')),
  idempotency_key varchar(128) NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (community_id,idempotency_key)
);

CREATE TABLE moderation_case_activity (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  kind varchar(32) NOT NULL CHECK (kind IN ('opened','assigned','status_changed','note','action_linked')),
  note varchar(2000),
  linked_action_id uuid,
  occurred_at timestamptz NOT NULL,
  CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000)
);

CREATE INDEX moderation_cases_queue_idx
  ON moderation_cases(community_id,status,updated_at DESC,id DESC);
CREATE INDEX moderation_case_activity_order_idx
  ON moderation_case_activity(case_id,occurred_at,id);
