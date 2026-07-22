CREATE TABLE message_mentions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mention_type varchar(16) NOT NULL CHECK (mention_type IN ('user','role','everyone')),
  target_id uuid NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(message_id,mention_type,target_id)
);
CREATE INDEX message_mentions_target_idx ON message_mentions(mention_type,target_id,message_id);
-- References remain after body edits and message tombstoning; notification
-- delivery independently rechecks current visibility, blocks, and preferences.
