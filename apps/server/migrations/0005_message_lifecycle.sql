ALTER TABLE messages
  ADD COLUMN reply_to_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key varchar(128),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

UPDATE messages SET idempotency_key = id::text WHERE idempotency_key IS NULL;
ALTER TABLE messages ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;

CREATE UNIQUE INDEX messages_idempotency_idx
  ON messages(author_id, space_id, idempotency_key);
CREATE INDEX messages_reply_to_idx ON messages(reply_to_id)
  WHERE reply_to_id IS NOT NULL;
