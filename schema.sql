CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  faction_id INTEGER,
  last_move INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  bonus_moves INTEGER NOT NULL DEFAULT 0,
  claims INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_faction ON users(faction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ip ON users(ip_hash);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS factions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL UNIQUE,
  capital_x INTEGER NOT NULL,
  capital_y INTEGER NOT NULL,
  pixels INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pixels (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  capital INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (x, y)
);
CREATE INDEX IF NOT EXISTS idx_pixels_updated ON pixels(updated_at);

CREATE TABLE IF NOT EXISTS user_devices (
  user_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_devices_hash ON user_devices(device_hash);

CREATE INDEX IF NOT EXISTS idx_pixels_faction ON pixels(faction_id);

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
