-- Ops Engine v0.3 sanitized request events

CREATE TABLE IF NOT EXISTS request_events (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  request_id TEXT,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  role TEXT NOT NULL,
  hashed_user_id TEXT,
  hashed_ip TEXT,
  user_agent_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_request_events_ts ON request_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_endpoint_ts ON request_events(endpoint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_role_ts ON request_events(role, ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_status_ts ON request_events(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_request_id ON request_events(request_id);

CREATE TABLE IF NOT EXISTS request_event_summaries (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 3600,
  total_events INTEGER NOT NULL DEFAULT 0,
  unique_ip_hashes INTEGER NOT NULL DEFAULT 0,
  unique_user_hashes INTEGER NOT NULL DEFAULT 0,
  roles_json TEXT NOT NULL DEFAULT '{}',
  endpoints_json TEXT NOT NULL DEFAULT '[]',
  statuses_json TEXT NOT NULL DEFAULT '{}',
  slow_events_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_request_event_summaries_collected ON request_event_summaries(collected_at DESC);
