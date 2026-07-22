CREATE TABLE instance_audit_events (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  action varchar(96) NOT NULL, target_id uuid, outcome varchar(32) NOT NULL,
  correlation_id varchar(128) NOT NULL, occurred_at timestamptz NOT NULL,
  previous_hash char(64), event_hash char(64) NOT NULL UNIQUE
);
CREATE INDEX instance_audit_page_idx ON instance_audit_events(occurred_at DESC,id DESC);
