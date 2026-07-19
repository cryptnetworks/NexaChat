ALTER TABLE accounts
  ADD COLUMN username varchar(32),
  ADD COLUMN normalized_username varchar(32),
  ADD COLUMN password_hash text,
  ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  ADD COLUMN credential_version integer NOT NULL DEFAULT 1
    CHECK (credential_version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX accounts_normalized_username_idx
  ON accounts(normalized_username) WHERE normalized_username IS NOT NULL;
CREATE INDEX accounts_status_idx ON accounts(status);

ALTER TABLE sessions
  ADD COLUMN credential_version integer NOT NULL DEFAULT 1
    CHECK (credential_version > 0),
  ADD COLUMN recent_auth_at timestamptz,
  ADD COLUMN idle_expires_at timestamptz;

UPDATE sessions SET recent_auth_at = created_at, idle_expires_at = expires_at
WHERE recent_auth_at IS NULL OR idle_expires_at IS NULL;

ALTER TABLE sessions
  ALTER COLUMN recent_auth_at SET NOT NULL,
  ALTER COLUMN idle_expires_at SET NOT NULL,
  ADD CHECK (idle_expires_at <= expires_at);

CREATE INDEX sessions_token_active_idx ON sessions(token_hash)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_account_created_idx ON sessions(account_id, created_at DESC);
