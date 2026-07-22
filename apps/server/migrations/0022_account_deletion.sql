CREATE TABLE account_deletion_jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  idempotency_key varchar(128) NOT NULL,
  status varchar(24) NOT NULL CHECK (status IN ('scheduled','running','blocked_hold','completed','cancelled','failed')),
  requested_at timestamptz NOT NULL,
  execute_after timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  export_id uuid REFERENCES export_jobs(id) ON DELETE SET NULL,
  correlation_id varchar(128) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (account_id,idempotency_key)
);

CREATE UNIQUE INDEX account_deletion_one_active_idx ON account_deletion_jobs(account_id)
  WHERE status IN ('scheduled','running','blocked_hold');
CREATE INDEX account_deletion_worker_idx ON account_deletion_jobs(status,execute_after,id);

CREATE TABLE deleted_identity_tombstones (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  identity_digest char(64) NOT NULL,
  deleted_at timestamptz NOT NULL,
  backup_exclusion_after timestamptz NOT NULL
);

-- Scheduling and session revocation occur in one transaction. Completion uses
-- row locking plus version checks; sole-owned communities and legal holds block
-- the worker before it crosses the irreversible running boundary.
