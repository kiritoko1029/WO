CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  disabled_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  identifier_normalized text NOT NULL,
  verified_at timestamp with time zone,
  CONSTRAINT auth_identities_provider_identifier_normalized_unique
    UNIQUE (provider, identifier_normalized)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_index
  ON auth_identities (user_id);

CREATE TABLE IF NOT EXISTS password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_changed_at timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash varchar(64) NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  rotated_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT refresh_sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS refresh_sessions_user_id_index
  ON refresh_sessions (user_id);

CREATE INDEX IF NOT EXISTS refresh_sessions_family_id_index
  ON refresh_sessions (family_id);
