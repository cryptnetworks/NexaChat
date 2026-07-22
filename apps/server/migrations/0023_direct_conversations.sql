CREATE TABLE direct_conversations (
  id uuid PRIMARY KEY,
  participant_low_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  participant_high_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  created_event_id uuid NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (participant_low_id < participant_high_id),
  UNIQUE (participant_low_id,participant_high_id)
);

CREATE TABLE direct_participants (
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  removed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (conversation_id,account_id)
);

CREATE TABLE direct_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  body varchar(4000),
  attachment_reference_ids uuid[] NOT NULL DEFAULT '{}',
  reply_to_id uuid REFERENCES direct_messages(id) ON DELETE SET NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  created_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (conversation_id,sequence),
  UNIQUE (conversation_id,author_id,idempotency_key),
  CHECK (cardinality(attachment_reference_ids) <= 10),
  CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR deleted_at IS NOT NULL)
);

CREATE INDEX direct_messages_page_idx ON direct_messages(conversation_id,sequence,id);
CREATE INDEX direct_messages_unread_idx ON direct_messages(conversation_id,author_id,sequence);
