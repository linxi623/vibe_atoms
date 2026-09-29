CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  owner_visitor_id uuid NOT NULL UNIQUE REFERENCES visitors(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_sessions_expiry_idx ON account_sessions(expires_at);
