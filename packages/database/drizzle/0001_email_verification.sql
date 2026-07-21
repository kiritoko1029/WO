CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  purpose text NOT NULL,
  code_hash varchar(64) NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT email_verification_challenges_purpose_check
    CHECK (purpose IN ('register', 'rebind'))
);

CREATE INDEX IF NOT EXISTS email_verification_challenges_user_purpose_index
  ON email_verification_challenges (user_id, purpose);

CREATE INDEX IF NOT EXISTS email_verification_challenges_email_index
  ON email_verification_challenges (email_normalized);
