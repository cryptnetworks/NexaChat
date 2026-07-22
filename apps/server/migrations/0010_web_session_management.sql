ALTER TABLE sessions ADD COLUMN public_handle varchar(32);

UPDATE sessions
SET public_handle = 'sess_' || encode(gen_random_bytes(12), 'hex');

ALTER TABLE sessions
  ALTER COLUMN public_handle SET NOT NULL,
  ADD CONSTRAINT auth_sessions_public_handle_shape CHECK (
    public_handle ~ '^sess_[A-Za-z0-9_-]{16,27}$'
  ),
  ADD CONSTRAINT auth_sessions_public_handle_unique UNIQUE (public_handle);

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_action_check,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'invitation.create', 'invitation.revoke', 'invitation.accept',
    'audit.checkpoint', 'audit.legal_hold.apply', 'audit.legal_hold.release',
    'account.credentials.change', 'account.sessions.revoke_all',
    'account.session.revoke', 'account.sessions.revoke_others'
  ));
