ALTER TABLE messages
  ADD COLUMN mention_account_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE space_read_positions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (account_id, space_id)
);

CREATE INDEX messages_space_order_idx ON messages(space_id, created_at, id);
CREATE INDEX messages_mentions_idx ON messages USING gin(mention_account_ids)
  WHERE deleted_at IS NULL;
