CREATE TABLE notifications (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL CHECK (kind IN ('mention','reply','invite','moderation_outcome')),
  scope_id uuid, resource_id uuid NOT NULL, actor_ids uuid[] NOT NULL,
  aggregate_count integer NOT NULL CHECK (aggregate_count BETWEEN 1 AND 10000),
  deduplication_key char(64) NOT NULL, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, read_at timestamptz, archived_at timestamptz,
  expires_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1,
  UNIQUE(account_id,deduplication_key), CHECK (cardinality(actor_ids) BETWEEN 1 AND 20)
);
CREATE INDEX notifications_page_idx ON notifications(account_id,updated_at DESC,id DESC);
CREATE INDEX notifications_expiry_idx ON notifications(expires_at,id);
