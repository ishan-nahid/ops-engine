export interface Env {
  DB: D1Database;
  APP_NAME?: string;
  PUBLIC_DASHBOARD_ORIGIN?: string;
  SMW_PUBLIC_URL?: string;
  SMW_HEALTH_SUMMARY_URL?: string;
  SMW_HEALTH_SUMMARY_TOKEN?: string;
  AGENT_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
}

type Status = "healthy" | "degraded" | "critical" | "unknown";

type AgentPayload = {
  source?: string;
  hostname?: string;
  generated_at?: string;
  status?: string;
  services?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  backups?: Record<string, unknown>;
  smw?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  security?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

function corsHeaders(env: Env): Record<string, string> {
  const origin = env.PUBLIC_DASHBOARD_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
  };
}

function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireBearer(request: Request, expected?: string): Response | null {
  if (!expected) {
    return json({ detail: "Server is missing required token configuration." }, { status: 503 });
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) {
    return json({ detail: "Not found." }, { status: 404 });
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getString(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const value = obj[key];
  return typeof value === "string" ? value : fallback;
}

function getNumber(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function summarizePayload(payload: AgentPayload): { status: Status; summary: Record<string, unknown> } {
  const services = asRecord(payload.services);
  const resources = asRecord(payload.resources);
  const backups = asRecord(payload.backups);
  const smw = asRecord(payload.smw);

  let status: Status = "healthy";
  const badServices: string[] = [];

  for (const [name, raw] of Object.entries(services)) {
    const item = asRecord(raw);
    const serviceStatus = String(item.status || raw || "unknown").toLowerCase();
    if (!["active", "ok", "running", "online", "healthy"].includes(serviceStatus)) {
      badServices.push(name);
    }
  }

  const diskUsedPct = getNumber(resources, "disk_used_pct");
  const memoryUsedPct = getNumber(resources, "memory_used_pct");
  const backupAgeHours = getNumber(backups, "latest_backup_age_hours");
  const smwStatus = String(smw.status || "unknown").toLowerCase();

  if (badServices.length || smwStatus === "down" || smwStatus === "critical") status = "critical";
  if (diskUsedPct !== null && diskUsedPct >= 90) status = "critical";
  if (memoryUsedPct !== null && memoryUsedPct >= 95) status = "critical";
  if (backupAgeHours !== null && backupAgeHours >= 36 && status !== "critical") status = "degraded";
  if (diskUsedPct !== null && diskUsedPct >= 80 && status === "healthy") status = "degraded";
  if (badServices.length === 0 && smwStatus === "degraded" && status === "healthy") status = "degraded";

  return {
    status,
    summary: {
      bad_services: badServices,
      disk_used_pct: diskUsedPct,
      memory_used_pct: memoryUsedPct,
      latest_backup_age_hours: backupAgeHours,
      smw_status: smwStatus,
    },
  };
}

async function upsertKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(
    "INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
  ).bind(key, JSON.stringify(value), nowIso()).run();
}

async function insertIncidentIfNeeded(db: D1Database, status: Status, source: string, summary: Record<string, unknown>): Promise<void> {
  if (status === "healthy" || status === "unknown") return;
  const open = await db.prepare(
    "SELECT id FROM incidents WHERE status = 'open' AND source = ? ORDER BY started_at DESC LIMIT 1",
  ).bind(source).first<{ id: string }>();
  if (open) return;

  await db.prepare(
    "INSERT INTO incidents (id, title, severity, status, source, started_at, summary, metadata_json) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)",
  ).bind(
    uuid(),
    status === "critical" ? "SMW critical health issue" : "SMW degraded health issue",
    status,
    source,
    nowIso(),
    JSON.stringify(summary),
    JSON.stringify({ created_by: "ops-engine" }),
  ).run();
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const authError = requireBearer(request, env.AGENT_TOKEN);
  if (authError) return authError;

  let payload: AgentPayload;
  try {
    payload = (await request.json()) as AgentPayload;
  } catch {
    return json({ detail: "Invalid JSON payload." }, { status: 400 });
  }

  const source = payload.source || "smw-droplet";
  const hostname = payload.hostname || "unknown";
  const receivedAt = nowIso();
  const { status, summary } = summarizePayload(payload);
  const heartbeatId = uuid();

  await env.DB.prepare(
    "INSERT INTO heartbeats (id, source, hostname, status, received_at, generated_at, payload_json, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    heartbeatId,
    source,
    hostname,
    status,
    receivedAt,
    payload.generated_at || null,
    JSON.stringify(payload),
    JSON.stringify(summary),
  ).run();

  const services = asRecord(payload.services);
  for (const [name, raw] of Object.entries(services)) {
    const item = asRecord(raw);
    const serviceStatus = String(item.status || raw || "unknown");
    await env.DB.prepare(
      "INSERT INTO service_snapshots (id, heartbeat_id, service_name, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(uuid(), heartbeatId, name, serviceStatus, JSON.stringify(item), receivedAt).run();
  }

  await upsertKv(env.DB, "latest_heartbeat", { id: heartbeatId, source, hostname, status, received_at: receivedAt, summary });
  await insertIncidentIfNeeded(env.DB, status, source, summary);

  return json({ ok: true, id: heartbeatId, status, received_at: receivedAt });
}

async function handleLatest(env: Env): Promise<Response> {
  const heartbeat = await env.DB.prepare(
    "SELECT id, source, hostname, status, received_at, generated_at, summary_json FROM heartbeats ORDER BY received_at DESC LIMIT 1",
  ).first();
  const uptime = await env.DB.prepare(
    "SELECT target_key, target_url, checked_at, ok, status_code, latency_ms, error FROM uptime_checks ORDER BY checked_at DESC LIMIT 20",
  ).all();
  const incidents = await env.DB.prepare(
    "SELECT id, title, severity, status, source, started_at, resolved_at, summary FROM incidents WHERE status = 'open' ORDER BY started_at DESC LIMIT 10",
  ).all();

  return json({ heartbeat, uptime: uptime.results || [], incidents: incidents.results || [] });
}

async function handleServices(env: Env): Promise<Response> {
  const latest = await env.DB.prepare("SELECT id FROM heartbeats ORDER BY received_at DESC LIMIT 1").first<{ id: string }>();
  if (!latest) return json({ services: [] });
  const services = await env.DB.prepare(
    "SELECT service_name, status, detail, checked_at FROM service_snapshots WHERE heartbeat_id = ? ORDER BY service_name ASC",
  ).bind(latest.id).all();
  return json({ heartbeat_id: latest.id, services: services.results || [] });
}

async function handleIncidents(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, title, severity, status, source, started_at, resolved_at, summary, metadata_json FROM incidents ORDER BY started_at DESC LIMIT 50",
  ).all();
  return json({ incidents: rows.results || [] });
}

async function resolveIncident(request: Request, env: Env, id: string): Promise<Response> {
  const authError = requireBearer(request, env.AGENT_TOKEN);
  if (authError) return authError;
  await env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return json({ ok: true, id });
}

async function handleErrors(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, fingerprint, status, first_seen, last_seen, count, latest_message, latest_request_id, latest_path, latest_severity FROM error_groups ORDER BY last_seen DESC LIMIT 50",
  ).all();
  return json({ error_groups: rows.results || [] });
}

async function checkTarget(env: Env, targetKey: string, targetUrl: string): Promise<void> {
  const started = Date.now();
  let ok = 0;
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const headers: Record<string, string> = { "user-agent": "ops-engine/0.1" };
    if (targetKey === "smw-health-summary" && env.SMW_HEALTH_SUMMARY_TOKEN) {
      headers.authorization = `Bearer ${env.SMW_HEALTH_SUMMARY_TOKEN}`;
    }
    const response = await fetch(targetUrl, { method: "GET", headers });
    statusCode = response.status;
    ok = response.ok ? 1 : 0;
  } catch (exc) {
    error = exc instanceof Error ? exc.message : "unknown fetch error";
  }

  const latency = Date.now() - started;
  await env.DB.prepare(
    "INSERT INTO uptime_checks (id, target_key, target_url, checked_at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(uuid(), targetKey, targetUrl, nowIso(), ok, statusCode, latency, error).run();

  if (!ok) {
    await insertIncidentIfNeeded(env.DB, "critical", `uptime:${targetKey}`, {
      target_key: targetKey,
      target_url: targetUrl,
      status_code: statusCode,
      error,
      latency_ms: latency,
    });
  }
}

async function runScheduledChecks(env: Env): Promise<void> {
  if (env.SMW_PUBLIC_URL) await checkTarget(env, "smw-public", env.SMW_PUBLIC_URL);
  if (env.SMW_HEALTH_SUMMARY_URL) await checkTarget(env, "smw-health-summary", env.SMW_HEALTH_SUMMARY_URL);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (path === "/" || path === "/api") return json({ name: env.APP_NAME || "Ops Engine", status: "ok" });
  if (path === "/api/agent/heartbeat" && request.method === "POST") return handleHeartbeat(request, env);
  if (path === "/api/status/latest" && request.method === "GET") return handleLatest(env);
  if (path === "/api/services" && request.method === "GET") return handleServices(env);
  if (path === "/api/incidents" && request.method === "GET") return handleIncidents(env);
  if (path.startsWith("/api/incidents/") && path.endsWith("/resolve") && request.method === "POST") {
    const id = path.split("/")[3];
    if (!id) return json({ detail: "Missing incident id." }, { status: 400 });
    return resolveIncident(request, env, id);
  }
  if (path === "/api/errors" && request.method === "GET") return handleErrors(env);

  return json({ detail: "Not found." }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await route(request, env), env);
    } catch (exc) {
      return withCors(json({ detail: "Internal error", error: exc instanceof Error ? exc.message : "unknown" }, { status: 500 }), env);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduledChecks(env);
  },
};
