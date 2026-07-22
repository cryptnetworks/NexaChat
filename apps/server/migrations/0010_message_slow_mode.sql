ALTER TABLE spaces
  ADD COLUMN slow_mode_seconds integer NOT NULL DEFAULT 0
  CHECK (slow_mode_seconds BETWEEN 0 AND 21600);

CREATE TABLE message_pacing (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  next_allowed_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, actor_id)
);
