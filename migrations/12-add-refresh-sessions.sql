CREATE TABLE IF NOT EXISTS refresh_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) UNIQUE NOT NULL,
  user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
  username VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by_hash CHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active
  ON refresh_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires_at
  ON refresh_sessions(expires_at);
