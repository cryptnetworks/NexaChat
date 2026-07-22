CREATE TABLE retention_policies (
  scope_type varchar(16) NOT NULL CHECK (scope_type IN ('instance','community','space')),
  scope_id varchar(128) NOT NULL,
  retain_days integer NOT NULL CHECK (retain_days BETWEEN 1 AND 3650),
  tombstone_days integer NOT NULL CHECK (tombstone_days BETWEEN 1 AND 3650),
  updated_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (scope_type,scope_id)
);

CREATE TABLE retention_checkpoints (
  worker_id varchar(128) PRIMARY KEY,
  cursor varchar(512),
  updated_at timestamptz NOT NULL
);

ALTER TABLE messages ADD COLUMN retention_purge_at timestamptz;
CREATE INDEX messages_retention_batch_idx
  ON messages(retention_purge_at,id) WHERE retention_purge_at IS NOT NULL;

-- Evidence and moderation audit rows are intentionally excluded. Holds are
-- checked in the same transaction that purges message bodies, edit history,
-- reactions, and attachment-object references. Object deletion uses an outbox.
CREATE TABLE retention_object_deletion_outbox (
  id uuid PRIMARY KEY,
  object_key_hash char(64) NOT NULL,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL,
  completed_at timestamptz
);
