ALTER TABLE messages
  ADD COLUMN request_fingerprint char(64),
  ADD COLUMN created_event_id uuid;

UPDATE messages
SET request_fingerprint = encode(sha256(convert_to(id::text, 'UTF8')), 'hex'),
    created_event_id = gen_random_uuid()
WHERE request_fingerprint IS NULL OR created_event_id IS NULL;

ALTER TABLE messages
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ALTER COLUMN created_event_id SET NOT NULL;

CREATE UNIQUE INDEX messages_created_event_idx ON messages(created_event_id);
