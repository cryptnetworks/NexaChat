CREATE TABLE account_recovery_idempotency (
  id uuid PRIMARY KEY,
  scope varchar(32) NOT NULL CHECK (
    scope IN ('recovery.request','recovery.complete')
  ),
  idempotency_key varchar(128) NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('pending','succeeded')),
  challenge_id uuid REFERENCES account_recovery_challenges(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (scope, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK ((state = 'pending' AND completed_at IS NULL)
    OR (state = 'succeeded' AND completed_at IS NOT NULL))
);

CREATE INDEX account_recovery_idempotency_expiry_idx
  ON account_recovery_idempotency(state, expires_at, id);

CREATE INDEX account_recovery_idempotency_challenge_idx
  ON account_recovery_idempotency(challenge_id)
  WHERE challenge_id IS NOT NULL;

CREATE TABLE instance_operators (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  recovery_control boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  CHECK (recovery_control)
);

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_version_supported,
  ADD CONSTRAINT audit_events_version_supported CHECK (event_version IN (1, 2));
