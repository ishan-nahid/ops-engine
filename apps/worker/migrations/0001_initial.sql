-- Ops Engine initial schema

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  generated_at TEXT,
  payload_json TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_received_at ON heartbeats(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_heartbeats_source_received_at ON heartbeats(source, received_at DESC);

CREATE TABLE IF NOT EXISTS service_snapshots (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_snapshots_service_checked ON service_snapshots(service_name, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_snapshots_heartbeat ON service_snapshots(heartbeat_id);

CREATE TABLE IF NOT EXISTS uptime_checks (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  target_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_uptime_checks_target_checked ON uptime_checks(target_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_uptime_checks_checked ON uptime_checks(checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_started ON incidents(status, started_at DESC);

CREATE TABLE IF NOT EXISTS error_groups (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  latest_message TEXT NOT NULL,
  latest_traceback TEXT,
  latest_request_id TEXT,
  latest_path TEXT,
  latest_severity TEXT NOT NULL DEFAULT 'error',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_error_groups_last_seen ON error_groups(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_error_groups_status_last_seen ON error_groups(status, last_seen DESC);

CREATE TABLE IF NOT EXISTS backup_checks (
  id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  latest_backup_path TEXT,
  latest_backup_age_hours REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_backup_checks_checked ON backup_checks(checked_at DESC);

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
