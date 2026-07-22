CREATE TABLE community_content_limits (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  message_body_max integer NOT NULL CHECK (message_body_max BETWEEN 1 AND 4000),
  report_description_max integer NOT NULL CHECK (report_description_max BETWEEN 1 AND 1000),
  moderation_reason_max integer NOT NULL CHECK (moderation_reason_max BETWEEN 1 AND 500),
  updated_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
