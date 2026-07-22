CREATE TABLE instance_registration_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  mode varchar(16) NOT NULL CHECK(mode IN ('open','invite_only','closed')),
  updated_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version > 0)
);
