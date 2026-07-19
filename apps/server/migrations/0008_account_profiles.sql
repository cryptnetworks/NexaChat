ALTER TABLE accounts
  ADD COLUMN profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  ADD COLUMN avatar_object_key varchar(255),
  ADD COLUMN avatar_media_type varchar(32),
  ADD COLUMN avatar_byte_length integer,
  ADD COLUMN avatar_sha256 char(64),
  ADD CONSTRAINT accounts_avatar_shape CHECK (
    (avatar_object_key IS NULL AND avatar_media_type IS NULL
      AND avatar_byte_length IS NULL AND avatar_sha256 IS NULL)
    OR
    (avatar_object_key ~ '^avatars/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,128}$'
      AND avatar_media_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND avatar_byte_length BETWEEN 1 AND 5242880
      AND avatar_sha256 ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX accounts_profile_updated_idx ON accounts(updated_at DESC, id);
