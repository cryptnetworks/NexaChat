CREATE TABLE member_discovery_documents (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  normalized_identifier varchar(80) NOT NULL,
  normalized_display_name varchar(80) NOT NULL,
  membership_version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (community_id,account_id)
);

CREATE INDEX member_discovery_prefix_idx
  ON member_discovery_documents(community_id,normalized_identifier,account_id);
CREATE INDEX member_discovery_name_idx
  ON member_discovery_documents(community_id,normalized_display_name,account_id);

CREATE TABLE space_discovery_documents (
  space_id uuid PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  normalized_name varchar(80) NOT NULL,
  space_version integer NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX space_discovery_name_idx
  ON space_discovery_documents(community_id,normalized_name,space_id);

-- Documents contain only normalized public-within-scope identifiers. Email,
-- address, report, evidence, role-sensitive, and presence fields are forbidden.
-- Every candidate is hydrated and reauthorized against current membership,
-- visibility, blocking, suspension, and archive state before rendering.
