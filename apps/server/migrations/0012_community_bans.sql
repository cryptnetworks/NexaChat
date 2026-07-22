ALTER TABLE moderation_restrictions
  DROP CONSTRAINT moderation_restrictions_kind_check,
  DROP CONSTRAINT moderation_restrictions_check,
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD CONSTRAINT moderation_restrictions_kind_check
    CHECK (kind IN ('timeout', 'ban')),
  ADD CONSTRAINT moderation_restrictions_expiry_check
    CHECK (expires_at IS NULL OR expires_at > created_at);

CREATE INDEX moderation_bans_target_idx
  ON moderation_restrictions(community_id, target_account_id, created_at DESC)
  WHERE kind='ban' AND revoked_at IS NULL;
