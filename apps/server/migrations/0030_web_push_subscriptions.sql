CREATE TABLE web_push_subscriptions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_ciphertext bytea NOT NULL, endpoint_hash char(64) NOT NULL,
  key_ciphertext bytea NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL, expires_at timestamptz,
  UNIQUE(account_id,endpoint_hash)
);
CREATE INDEX web_push_active_idx ON web_push_subscriptions(account_id,id) WHERE active;
