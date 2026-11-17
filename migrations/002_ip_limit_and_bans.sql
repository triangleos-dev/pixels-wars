-- Run ONCE on an existing database:
--   wrangler d1 execute pixel-wars --remote --file=migrations/002_ip_limit_and_bans.sql
-- (Fresh installs use schema.sql, which already includes these columns.)

ALTER TABLE users ADD COLUMN ip_hash TEXT;
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN ban_reason TEXT;

-- NULLs are allowed many times, so old accounts without an IP don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ip ON users(ip_hash);
