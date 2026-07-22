CREATE TABLE community_spam_rules (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 5 AND 3600),
  flood_threshold integer NOT NULL CHECK (flood_threshold BETWEEN 2 AND 100),
  repetition_threshold integer NOT NULL CHECK (repetition_threshold BETWEEN 2 AND 20),
  updated_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE spam_signals (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  signal_type varchar(24) NOT NULL CHECK (signal_type IN ('flood','repetition')),
  explanation_code varchar(64) NOT NULL,
  content_digest char(64) NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > observed_at)
);

CREATE INDEX spam_signals_expiry_idx ON spam_signals(expires_at);
CREATE INDEX spam_signals_review_idx
  ON spam_signals(community_id,observed_at DESC,id DESC);
