CREATE TABLE notification_read_state (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stream varchar(128) NOT NULL, sequence bigint NOT NULL CHECK (sequence >= 0),
  event_id uuid NOT NULL, updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(account_id,stream)
);
-- Implementations use GREATEST(sequence, candidate) so concurrent devices can
-- never move a read position backward. Compact events contain no notification body.
