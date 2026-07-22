ALTER TABLE background_jobs
  ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN available_at timestamptz,
  ADD COLUMN lease_owner varchar(128),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code varchar(32),
  ADD CONSTRAINT background_jobs_checkpoint_object
    CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 4096),
  ADD CONSTRAINT background_jobs_error_code
    CHECK (last_error_code IS NULL OR last_error_code IN ('handler_failed','timeout')),
  ADD CONSTRAINT background_jobs_lease_shape
    CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    );

UPDATE background_jobs SET available_at = created_at WHERE available_at IS NULL;
UPDATE background_jobs
SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    started_at = NULL,
    completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
    last_error_code = CASE WHEN attempts >= max_attempts THEN 'handler_failed' ELSE NULL END,
    version = version + 1
WHERE status = 'running';

ALTER TABLE background_jobs ALTER COLUMN available_at SET NOT NULL;

DROP INDEX background_jobs_worker_idx;
CREATE INDEX background_jobs_worker_idx
  ON background_jobs(status,available_at,lease_expires_at,created_at,id);
