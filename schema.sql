CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL,
  client_ts    TEXT,
  source       TEXT,
  app_version  TEXT,
  title        TEXT,
  body         TEXT,
  payload      TEXT NOT NULL,
  ip_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_received ON feedback(received_at);
CREATE INDEX IF NOT EXISTS idx_feedback_iphash ON feedback(ip_hash);
