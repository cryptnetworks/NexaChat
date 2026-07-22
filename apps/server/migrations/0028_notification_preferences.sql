CREATE TABLE notification_preferences (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope_type varchar(16) NOT NULL CHECK (scope_type IN ('account','community','category','space')),
  scope_id uuid NOT NULL, mode varchar(16) NOT NULL CHECK (mode IN ('all','mentions','none')),
  muted_until timestamptz, updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(account_id,scope_type,scope_id)
);
