CREATE TABLE message_threads (
  root_message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0), updated_at timestamptz NOT NULL
);
CREATE TABLE thread_replies (
  id uuid PRIMARY KEY, root_message_id uuid NOT NULL REFERENCES message_threads(root_message_id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, body varchar(4000),
  sequence bigint NOT NULL, idempotency_key varchar(128) NOT NULL, fingerprint char(64) NOT NULL,
  event_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE(root_message_id,sequence), UNIQUE(root_message_id,author_id,idempotency_key)
);
CREATE TABLE thread_read_state (
  root_message_id uuid NOT NULL REFERENCES message_threads(root_message_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL,
  PRIMARY KEY(root_message_id,account_id)
);
