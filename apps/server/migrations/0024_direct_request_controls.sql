CREATE TABLE direct_privacy_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  preference varchar(16) NOT NULL CHECK (preference IN ('allow','request','deny')),
  require_mutual_community boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE direct_conversation_requests (
  id uuid PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL CHECK (status IN ('pending','accepted','denied','ignored','blocked','expired')),
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (requester_id <> recipient_id),
  UNIQUE (requester_id,idempotency_key)
);

CREATE UNIQUE INDEX direct_requests_one_active_pair_idx
  ON direct_conversation_requests(requester_id,recipient_id)
  WHERE status IN ('pending','accepted','ignored');
CREATE INDEX direct_requests_recipient_page_idx
  ON direct_conversation_requests(recipient_id,status,created_at,id);
CREATE INDEX direct_requests_expiry_idx
  ON direct_conversation_requests(expires_at,id) WHERE status = 'pending';

CREATE TABLE account_blocks (
  blocker_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_request_id uuid REFERENCES direct_conversation_requests(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blocker_id,blocked_id),
  CHECK (blocker_id <> blocked_id)
);
