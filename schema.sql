CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL,
  client_ts    TEXT,
  source       TEXT,
  app_version  TEXT,
  title        TEXT,
  body         TEXT,
  payload      TEXT NOT NULL,
  ip_hash      TEXT,
  tester_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_received ON feedback(received_at);
CREATE INDEX IF NOT EXISTS idx_feedback_iphash ON feedback(ip_hash);

-- Automatic observations from the Loom/Orbit collector (contract C2). Low-bar,
-- untrusted content: only the maintainer triage pass reads it, and nothing here
-- is ever published. Rows self-destruct via the daily cron sweep on expires_at.
CREATE TABLE IF NOT EXISTS observations (
  id            TEXT PRIMARY KEY,
  received_at   TEXT NOT NULL,
  expires_at    TEXT NOT NULL,          -- received_at + 180 days
  kind          TEXT NOT NULL,
  stage         TEXT NOT NULL,
  signature     TEXT NOT NULL,
  tool_ids      TEXT NOT NULL,          -- JSON array of tool ids
  install_hash  TEXT NOT NULL,          -- HMAC-SHA256(installToken, OBS_HASH_SECRET || month) hex[0:32]
  ip_hash TEXT NOT NULL,
  retract_hash  TEXT NOT NULL,          -- sha256(retractToken) hex
  observation   TEXT NOT NULL           -- the validated Observation JSON, installToken REMOVED
);
CREATE INDEX IF NOT EXISTS idx_obs_received ON observations(received_at);
CREATE INDEX IF NOT EXISTS idx_obs_cluster  ON observations(kind, signature);
CREATE INDEX IF NOT EXISTS idx_obs_expires  ON observations(expires_at);
CREATE INDEX IF NOT EXISTS idx_obs_ip       ON observations(ip_hash, received_at);
