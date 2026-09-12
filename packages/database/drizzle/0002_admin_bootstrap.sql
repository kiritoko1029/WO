CREATE TABLE wo_meta.admin_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES auth_identities(id) ON DELETE RESTRICT,
  email_normalized text NOT NULL,
  created_at timestamp with time zone NOT NULL
);
