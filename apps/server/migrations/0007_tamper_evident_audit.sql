CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_events
  ADD COLUMN chain_index bigint,
  ADD COLUMN previous_hash char(64),
  ADD COLUMN event_hash char(64);

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
        prior_hash, id::text, actor_id::text, COALESCE(community_id::text, ''),
        COALESCE(invitation_id::text, ''), action, outcome,
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
    NEW.previous_hash, NEW.id::text, NEW.actor_id::text,
    COALESCE(NEW.community_id::text, ''), COALESCE(NEW.invitation_id::text, ''),
    NEW.action, NEW.outcome,
    to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ), 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER audit_events_append_chain
  BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION append_audit_event();
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
