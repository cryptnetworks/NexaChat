CREATE TABLE export_jobs (
  id uuid PRIMARY KEY,
  kind varchar(16) NOT NULL CHECK (kind IN ('user','community')),
  requester_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  subject_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('queued','running','ready','failed','revoked','expired')),
  schema_version smallint NOT NULL DEFAULT 1,
  object_reference varchar(512),
  manifest_digest char(64),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code varchar(64),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (requester_id,idempotency_key)
);

CREATE INDEX export_jobs_worker_idx ON export_jobs(status,created_at,id);
CREATE INDEX export_jobs_expiry_idx ON export_jobs(expires_at,id)
  WHERE status = 'ready';

CREATE TABLE export_audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  export_id uuid NOT NULL REFERENCES export_jobs(id) ON DELETE RESTRICT,
  action varchar(64) NOT NULL,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('succeeded','rejected')),
  correlation_id varchar(128) NOT NULL,
  occurred_at timestamptz NOT NULL
);
