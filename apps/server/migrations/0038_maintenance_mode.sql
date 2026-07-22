CREATE TABLE instance_maintenance_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), active boolean NOT NULL,
  retry_after_seconds integer NOT NULL CHECK(retry_after_seconds BETWEEN 5 AND 3600),
  reason_code varchar(64) NOT NULL, updated_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version > 0)
);
