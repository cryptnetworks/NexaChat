ALTER TABLE accounts
  ADD COLUMN recovery_epoch integer NOT NULL DEFAULT 1 CHECK (recovery_epoch > 0),
  ADD COLUMN recovery_locked boolean NOT NULL DEFAULT false;

CREATE TABLE account_recovery_methods (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL CHECK (kind IN ('email','phone','security_key')),
  destination_ciphertext text NOT NULL CHECK (octet_length(destination_ciphertext) <= 8192),
  destination_digest char(64) NOT NULL CHECK (destination_digest ~ '^[0-9a-f]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('pending','verified','revoked')),
  created_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (account_id, destination_digest)
);

CREATE INDEX account_recovery_methods_account_state_idx
  ON account_recovery_methods(account_id, state, created_at DESC, id);

CREATE TABLE account_recovery_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  method_id uuid REFERENCES account_recovery_methods(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL CHECK (
    purpose IN ('account_recovery','method_enrollment','method_replacement','method_revocation')
  ),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  epoch integer NOT NULL CHECK (epoch > 0),
  state varchar(16) NOT NULL CHECK (state IN ('pending','used','expired','invalidated')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  used_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'account_recovery' AND method_id IS NULL)
    OR (purpose <> 'account_recovery' AND method_id IS NOT NULL))
);

CREATE INDEX account_recovery_challenges_expiry_idx
  ON account_recovery_challenges(state, expires_at, id);
CREATE INDEX account_recovery_challenges_account_epoch_idx
  ON account_recovery_challenges(account_id, epoch, state, id);

CREATE TABLE recovery_delivery_requests (
  id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES account_recovery_challenges(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX recovery_delivery_requests_worker_idx
  ON recovery_delivery_requests(state, expires_at, created_at, id);

ALTER TABLE security_notifications
  DROP CONSTRAINT security_notifications_notification_type_check,
  ADD CONSTRAINT security_notifications_notification_type_check CHECK (
    notification_type IN (
      'credentials_changed','sessions_revoked','recovery_requested',
      'credentials_recovered','method_verified','method_revoked',
      'recovery_state_changed'
    )
  );

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_action_check,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'invitation.create', 'invitation.revoke', 'invitation.accept',
    'audit.checkpoint', 'audit.legal_hold.apply', 'audit.legal_hold.release',
    'account.credentials.change', 'account.session.revoke',
    'account.sessions.revoke_all', 'account.sessions.revoke_others',
    'account.recovery.request', 'account.recovery.complete',
    'account.recovery.method.verify', 'account.recovery.method.revoke',
    'account.recovery.operator.lock', 'account.recovery.operator.unlock',
    'account.recovery.operator.invalidate'
  ));

CREATE TRIGGER account_recovery_methods_no_update
  BEFORE UPDATE ON account_recovery_methods FOR EACH ROW
  WHEN (OLD.state = 'revoked' AND NEW.state <> 'revoked')
  EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER account_recovery_challenges_no_delete
  BEFORE DELETE ON account_recovery_challenges FOR EACH ROW
  EXECUTE FUNCTION reject_audit_event_mutation();
