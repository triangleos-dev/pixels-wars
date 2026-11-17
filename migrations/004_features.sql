-- Run ONCE on an existing database (after 002 and 003):
--   npx wrangler d1 execute pixel-wars --remote --file=migrations/004_features.sql
-- (Fresh installs use schema.sql, which already includes all of this.)

ALTER TABLE users ADD COLUMN bonus_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN claims INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  fa TEXT, ca TEXT,
  fv TEXT, cv TEXT,
  x INTEGER, y INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pixels_faction ON pixels(faction_id);
