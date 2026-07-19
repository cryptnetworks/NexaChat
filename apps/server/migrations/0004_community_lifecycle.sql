ALTER TABLE communities
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN normalized_name varchar(80) GENERATED ALWAYS AS
    (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) STORED;

CREATE UNIQUE INDEX communities_active_owner_name_idx
  ON communities (owner_id, normalized_name) WHERE archived_at IS NULL;
CREATE INDEX communities_visible_idx
  ON communities (archived_at, normalized_name, id);

ALTER TABLE memberships
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

DROP INDEX categories_active_name_idx;
ALTER TABLE categories
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN normalized_name varchar(80) GENERATED ALWAYS AS
    (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) STORED;
CREATE UNIQUE INDEX categories_active_name_idx
  ON categories (community_id, normalized_name) WHERE archived_at IS NULL;

DROP INDEX spaces_active_name_idx;
ALTER TABLE spaces
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN normalized_name varchar(80) GENERATED ALWAYS AS
    (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) STORED;
CREATE UNIQUE INDEX spaces_active_name_idx
  ON spaces (community_id, normalized_name) WHERE archived_at IS NULL;
