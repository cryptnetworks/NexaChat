CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  target_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (expires_at > created_at)
);

CREATE INDEX invitations_community_created_idx
  ON invitations(community_id, created_at DESC, id);
CREATE INDEX invitations_active_expiry_idx
  ON invitations(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  community_id uuid REFERENCES communities(id) ON DELETE SET NULL,
  invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL,
  action varchar(32) NOT NULL CHECK (
    action IN ('invitation.create', 'invitation.revoke', 'invitation.accept')
  ),
  outcome varchar(16) NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX audit_events_community_time_idx
  ON audit_events(community_id, occurred_at DESC, id);
