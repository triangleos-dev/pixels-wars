-- Run ONCE on an existing database:
--   npx wrangler d1 execute pixel-wars --remote --file=migrations/003_devices.sql
-- (Fresh installs use schema.sql, which already includes this table.)

CREATE TABLE IF NOT EXISTS user_devices (
  user_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_devices_hash ON user_devices(device_hash);
