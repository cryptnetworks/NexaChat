CREATE TABLE account_suspensions (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, reason varchar(500) NOT NULL,
  idempotency_key varchar(128) NOT NULL, created_at timestamptz NOT NULL,
  expires_at timestamptz, restored_at timestamptz, version integer NOT NULL DEFAULT 1,
  UNIQUE(actor_id,idempotency_key), CHECK(actor_id <> account_id)
);
CREATE INDEX account_suspensions_effective_idx ON account_suspensions(account_id,expires_at) WHERE restored_at IS NULL;
