ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_action_check,
  DROP CONSTRAINT audit_events_target_shape,
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'invitation.create', 'invitation.revoke', 'invitation.accept',
    'audit.checkpoint', 'audit.legal_hold.apply', 'audit.legal_hold.release',
    'account.credentials.change', 'account.sessions.revoke_all'
  )),
  ADD CONSTRAINT audit_events_target_shape CHECK (
    (target_type = 'none' AND target_id IS NULL AND invitation_id IS NULL)
    OR (target_type = 'invitation' AND target_id IS NOT NULL AND invitation_id = target_id)
    OR (target_type IN ('account', 'community', 'audit_chain')
      AND target_id IS NOT NULL AND invitation_id IS NULL)
  );

CREATE TABLE security_notifications (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  notification_type varchar(32) NOT NULL CHECK (
    notification_type IN ('credentials_changed', 'sessions_revoked')
  ),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > occurred_at)
);

CREATE INDEX security_notifications_account_time_idx
  ON security_notifications(account_id, occurred_at DESC, id);
CREATE INDEX security_notifications_expiry_idx
  ON security_notifications(expires_at);

CREATE TRIGGER security_notifications_no_update
  BEFORE UPDATE ON security_notifications FOR EACH ROW
  EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER security_notifications_no_delete
  BEFORE DELETE ON security_notifications FOR EACH ROW
  EXECUTE FUNCTION reject_audit_event_mutation();
