CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_events
  ALTER COLUMN actor_id DROP NOT NULL,
  ADD COLUMN event_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN actor_type varchar(16) NOT NULL DEFAULT 'account',
  ADD COLUMN service_id varchar(128),
  ADD COLUMN scope_type varchar(16) NOT NULL DEFAULT 'instance',
  ADD COLUMN scope_id uuid,
  ADD COLUMN target_type varchar(16) NOT NULL DEFAULT 'none',
  ADD COLUMN target_id uuid,
  ADD COLUMN reason_code varchar(64),
  ADD COLUMN correlation_id uuid,
  ADD COLUMN retention_until timestamptz,
  ADD COLUMN chain_index bigint,
  ADD COLUMN previous_hash char(64),
  ADD COLUMN event_hash char(64);

UPDATE audit_events SET
  scope_type = CASE WHEN community_id IS NULL THEN 'instance' ELSE 'community' END,
  scope_id = community_id,
  target_type = CASE WHEN invitation_id IS NULL THEN 'none' ELSE 'invitation' END,
  target_id = invitation_id,
  correlation_id = id,
  retention_until = occurred_at + interval '7 years';

ALTER TABLE audit_events
  ALTER COLUMN correlation_id SET NOT NULL,
  ALTER COLUMN retention_until SET NOT NULL,
  DROP CONSTRAINT audit_events_action_check,
  ADD CONSTRAINT audit_events_version_supported CHECK (event_version = 1),
  ADD CONSTRAINT audit_events_actor_shape CHECK (
    (actor_type = 'account' AND actor_id IS NOT NULL AND service_id IS NULL)
    OR (actor_type = 'service' AND actor_id IS NULL AND service_id ~ '^[a-z][a-z0-9._-]{2,127}$')
  ),
  ADD CONSTRAINT audit_events_scope_shape CHECK (
    (scope_type = 'instance' AND scope_id IS NULL AND community_id IS NULL)
    OR (scope_type = 'community' AND scope_id IS NOT NULL AND community_id = scope_id)
  ),
  ADD CONSTRAINT audit_events_target_shape CHECK (
    (target_type = 'none' AND target_id IS NULL AND invitation_id IS NULL)
    OR (target_type = 'invitation' AND target_id IS NOT NULL AND invitation_id = target_id)
    OR (target_type IN ('community', 'audit_chain') AND target_id IS NOT NULL AND invitation_id IS NULL)
  ),
  ADD CONSTRAINT audit_events_action_check CHECK (action IN (
    'invitation.create', 'invitation.revoke', 'invitation.accept',
    'audit.checkpoint', 'audit.legal_hold.apply', 'audit.legal_hold.release'
  )),
  ADD CONSTRAINT audit_events_reason_shape CHECK (
    reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  ADD CONSTRAINT audit_events_retention_shape CHECK (retention_until >= occurred_at);

DO $$
DECLARE
  current_event audit_events%ROWTYPE;
  prior_hash text;
  prior_index bigint;
BEGIN
  FOR current_event IN
    SELECT * FROM audit_events
    ORDER BY community_id NULLS FIRST, occurred_at, id
  LOOP
    SELECT event_hash, chain_index INTO prior_hash, prior_index
    FROM audit_events
    WHERE community_id IS NOT DISTINCT FROM current_event.community_id
      AND event_hash IS NOT NULL
    ORDER BY chain_index DESC
    LIMIT 1;

    prior_hash := COALESCE(prior_hash, repeat('0', 64));
    prior_index := COALESCE(prior_index, 0) + 1;
    UPDATE audit_events SET
      chain_index = prior_index,
      previous_hash = prior_hash,
      event_hash = encode(digest(concat_ws('|',
        prior_hash, event_version::text, id::text, actor_type,
        COALESCE(actor_id::text, service_id, ''), scope_type,
        COALESCE(scope_id::text, ''), target_type, COALESCE(target_id::text, ''),
        action, outcome, COALESCE(reason_code, ''), correlation_id::text,
        to_char(retention_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ), 'sha256'), 'hex')
    WHERE id = current_event.id;
  END LOOP;
END $$;

ALTER TABLE audit_events
  ALTER COLUMN chain_index SET NOT NULL,
  ALTER COLUMN previous_hash SET NOT NULL,
  ALTER COLUMN event_hash SET NOT NULL,
  ADD CONSTRAINT audit_events_chain_index_positive CHECK (chain_index > 0),
  ADD CONSTRAINT audit_events_previous_hash_shape CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT audit_events_event_hash_shape CHECK (event_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX audit_events_community_chain_idx
  ON audit_events(COALESCE(community_id, '00000000-0000-0000-0000-000000000000'::uuid), chain_index);
CREATE INDEX audit_events_retention_idx
  ON audit_events(community_id, retention_until, chain_index);

CREATE FUNCTION append_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_key text := COALESCE(NEW.community_id::text, 'instance');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_key, 25));
  SELECT chain_index, event_hash INTO NEW.chain_index, NEW.previous_hash
  FROM audit_events
  WHERE community_id IS NOT DISTINCT FROM NEW.community_id
  ORDER BY chain_index DESC
  LIMIT 1;
  NEW.chain_index := COALESCE(NEW.chain_index, 0) + 1;
  NEW.previous_hash := COALESCE(NEW.previous_hash, repeat('0', 64));
  NEW.event_hash := encode(digest(concat_ws('|',
    NEW.previous_hash, NEW.event_version::text, NEW.id::text, NEW.actor_type,
    COALESCE(NEW.actor_id::text, NEW.service_id, ''), NEW.scope_type,
    COALESCE(NEW.scope_id::text, ''), NEW.target_type, COALESCE(NEW.target_id::text, ''),
    NEW.action, NEW.outcome, COALESCE(NEW.reason_code, ''), NEW.correlation_id::text,
    to_char(NEW.retention_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ), 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER audit_events_append_chain
  BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION append_audit_event();
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TABLE audit_checkpoints (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  chain_index bigint NOT NULL CHECK (chain_index > 0),
  head_hash char(64) NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  actor_type varchar(16) NOT NULL,
  actor_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  service_id varchar(128),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (community_id, chain_index),
  CHECK (
    (actor_type = 'account' AND actor_id IS NOT NULL AND service_id IS NULL)
    OR (actor_type = 'service' AND actor_id IS NULL AND service_id ~ '^[a-z][a-z0-9._-]{2,127}$')
  )
);

CREATE FUNCTION validate_audit_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_index bigint;
  current_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.community_id::text, 25));
  SELECT chain_index, event_hash INTO current_index, current_hash
  FROM audit_events WHERE community_id = NEW.community_id
  ORDER BY chain_index DESC LIMIT 1;
  IF current_index IS NULL OR NEW.chain_index <> current_index OR NEW.head_hash <> current_hash THEN
    RAISE EXCEPTION 'audit checkpoint does not match current chain' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_checkpoints_validate
  BEFORE INSERT ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION validate_audit_checkpoint();
CREATE TRIGGER audit_checkpoints_no_update
  BEFORE UPDATE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER audit_checkpoints_no_delete
  BEFORE DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
