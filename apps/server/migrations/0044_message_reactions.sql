CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reaction_key varchar(32) NOT NULL CHECK (length(reaction_key) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (message_id, actor_id, reaction_key)
);

CREATE INDEX message_reactions_aggregate_idx
  ON message_reactions(message_id, reaction_key, actor_id);
