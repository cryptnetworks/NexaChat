CREATE TABLE notification_source_events (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id,event_id)
);
CREATE INDEX notification_source_events_cleanup_idx
  ON notification_source_events(created_at,account_id,event_id);
