CREATE TABLE community_export_grants (
  export_id uuid PRIMARY KEY REFERENCES export_jobs(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  authorization_version bigint NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX community_export_grants_scope_idx
  ON community_export_grants(community_id,export_id);

-- The worker locks both the job and current authorization snapshot before
-- materialization. Retrieval repeats the same permission check; this grant is
-- diagnostic state and never substitutes for current authorization.
