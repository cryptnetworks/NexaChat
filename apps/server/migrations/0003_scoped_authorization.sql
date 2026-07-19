CREATE TABLE authorization_roles (
  id uuid PRIMARY KEY,
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0),
  position integer NOT NULL CHECK (position >= 0),
  protected boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE NULLS NOT DISTINCT (community_id, name),
  UNIQUE NULLS NOT DISTINCT (community_id, position)
);

CREATE TABLE authorization_role_assignments (
  role_id uuid NOT NULL REFERENCES authorization_roles(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (role_id, actor_id)
);
CREATE INDEX authorization_assignments_actor_idx ON authorization_role_assignments(actor_id, community_id);

CREATE TABLE authorization_decisions (
  role_id uuid NOT NULL REFERENCES authorization_roles(id) ON DELETE CASCADE,
  permission varchar(64) NOT NULL,
  scope_type varchar(16) NOT NULL CHECK (scope_type IN ('instance', 'community', 'category', 'space', 'resource')),
  scope_id uuid NOT NULL,
  effect varchar(8) NOT NULL CHECK (effect IN ('grant', 'deny')),
  PRIMARY KEY (role_id, permission, scope_type, scope_id)
);
CREATE INDEX authorization_decisions_scope_idx ON authorization_decisions(scope_type, scope_id, permission);

CREATE TABLE community_ownership_versions (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO community_ownership_versions (community_id) SELECT id FROM communities;

CREATE FUNCTION initialize_community_ownership_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO community_ownership_versions (community_id) VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER communities_initialize_ownership_version AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION initialize_community_ownership_version();
