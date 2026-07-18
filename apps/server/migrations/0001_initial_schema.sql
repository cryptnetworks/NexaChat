CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  display_name varchar(80) NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE communities (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX communities_owner_id_idx ON communities(owner_id);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL CHECK (
    status IN ('active', 'invited', 'left', 'removed', 'suspended')
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (community_id, account_id)
);

CREATE INDEX memberships_account_status_idx ON memberships(account_id, status);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0),
  position integer NOT NULL CHECK (position >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX categories_active_name_idx
  ON categories (community_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX categories_navigation_idx
  ON categories (community_id, archived_at, position, id);

CREATE TABLE spaces (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0),
  kind varchar(16) NOT NULL CHECK (kind = 'text'),
  position integer NOT NULL CHECK (position >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX spaces_active_name_idx
  ON spaces (community_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX spaces_navigation_idx
  ON spaces (community_id, category_id, archived_at, position, id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
  author_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  body varchar(4000) NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX messages_history_idx ON messages(space_id, created_at DESC, id DESC);
CREATE INDEX messages_author_id_idx ON messages(author_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_account_active_idx
  ON sessions(account_id, expires_at) WHERE revoked_at IS NULL;
