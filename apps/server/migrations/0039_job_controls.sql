CREATE TABLE background_jobs (
  id uuid PRIMARY KEY, kind varchar(64) NOT NULL,
  status varchar(24) NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancel_requested','cancelled')),
  attempts smallint NOT NULL DEFAULT 0, max_attempts smallint NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
  deduplication_key varchar(128) NOT NULL, payload_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL, started_at timestamptz, completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), UNIQUE(kind,deduplication_key)
);
CREATE INDEX background_jobs_worker_idx ON background_jobs(status,created_at,id);
