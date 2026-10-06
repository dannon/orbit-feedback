-- One-off for a database whose observations table predates ip_hash. Fresh
-- databases get the column from schema.sql; this runs ONCE on the live one:
--   npx wrangler d1 execute orbit-feedback --remote --file=./migrations/2026-10-06-observations-ip-hash.sql
-- ADD COLUMN is not idempotent, so a second run fails loudly rather than silently.
ALTER TABLE observations ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_obs_ip ON observations(ip_hash, received_at);
