CREATE TABLE message_search_documents (
  message_id uuid PRIMARY KEY,
  scope_type varchar(16) NOT NULL CHECK (scope_type IN ('space','direct')),
  scope_id uuid NOT NULL,
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  document tsvector NOT NULL,
  created_at timestamptz NOT NULL,
  indexed_version integer NOT NULL CHECK (indexed_version > 0),
  updated_at timestamptz NOT NULL
);

CREATE INDEX message_search_document_gin_idx ON message_search_documents USING gin(document);
CREATE INDEX message_search_scope_page_idx
  ON message_search_documents(scope_type,scope_id,created_at DESC,message_id DESC);
CREATE INDEX message_search_community_page_idx
  ON message_search_documents(community_id,created_at DESC,message_id DESC)
  WHERE community_id IS NOT NULL;

CREATE TABLE message_search_outbox (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('upsert','delete')),
  message_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  completed_at timestamptz,
  UNIQUE (message_id,message_version,operation)
);

-- Index candidates are never authoritative. Query scope and every hydrated
-- result are checked against current PostgreSQL authorization, deletion,
-- retention, blocking, and participant state before rendering.
