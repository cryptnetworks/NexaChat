CREATE TABLE saved_messages (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL, UNIQUE(account_id,message_id)
);
CREATE INDEX saved_messages_page_idx ON saved_messages(account_id,created_at DESC,id DESC);
