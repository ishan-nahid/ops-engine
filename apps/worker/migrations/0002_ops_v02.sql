-- Ops Engine v0.2 operational analytics

CREATE TABLE IF NOT EXISTS api_traffic_summaries (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 3600,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_2xx INTEGER NOT NULL DEFAULT 0,
  total_3xx INTEGER NOT NULL DEFAULT 0,
  total_4xx INTEGER NOT NULL DEFAULT 0,
  total_5xx INTEGER NOT NULL DEFAULT 0,
  top_paths_json TEXT NOT NULL DEFAULT '[]',
  status_codes_json TEXT NOT NULL DEFAULT '{}',
  methods_json TEXT NOT NULL DEFAULT '{}',
  slow_paths_json TEXT NOT NULL DEFAULT '[]',
  privacy_mode TEXT NOT NULL DEFAULT 'aggregate',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_traffic_collected ON api_traffic_summaries(collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_traffic_source_collected ON api_traffic_summaries(source, collected_at DESC);

CREATE TABLE IF NOT EXISTS deploy_snapshots (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  branch TEXT,
  sha TEXT,
  short_sha TEXT,
  is_dirty INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_snapshots_collected ON deploy_snapshots(collected_at DESC);

CREATE TABLE IF NOT EXISTS server_snapshots (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  hostname TEXT NOT NULL,
  disk_used_pct REAL,
  memory_used_pct REAL,
  load1 REAL,
  load5 REAL,
  load15 REAL,
  uptime_seconds INTEGER,
  cpu_count INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_collected ON server_snapshots(collected_at DESC);
