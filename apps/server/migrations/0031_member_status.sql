CREATE TABLE member_statuses (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status_text varchar(160), expires_at timestamptz, updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX member_status_expiry_idx ON member_statuses(expires_at,account_id) WHERE expires_at IS NOT NULL;
