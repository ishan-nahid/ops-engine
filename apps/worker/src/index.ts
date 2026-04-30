export interface Env {
  DB: D1Database;
  APP_NAME?: string;
  PUBLIC_DASHBOARD_ORIGIN?: string;
  SMW_PUBLIC_URL?: string;
  SMW_HEALTH_SUMMARY_URL?: string;
  SMW_HEALTH_SUMMARY_TOKEN?: string;
  AGENT_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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
  api_traffic?: Record<string, unknown>;
  request_events?: unknown[];
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data, null, 2), { ...init, headers: { ...jsonHeaders, ...(init.headers || {}) } });
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function corsHeaders(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.PUBLIC_DASHBOARD_ORIGIN || "*",
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

function requireBearer(request: Request, expected?: string): Response | null {
  if (!expected) return json({ detail: "Server is missing required token configuration." }, { status: 503 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) return json({ detail: "Not found." }, { status: 404 });
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  const apiTraffic = asRecord(payload.api_traffic);
  let status: Status = "healthy";
  const badServices: string[] = [];

  for (const [name, raw] of Object.entries(services)) {
    const item = asRecord(raw);
    const serviceStatus = String(item.status || raw || "unknown").toLowerCase();
    if (!["active", "ok", "running", "online", "healthy"].includes(serviceStatus)) badServices.push(name);
  }

  const diskUsedPct = getNumber(resources, "disk_used_pct");
  const memoryUsedPct = getNumber(resources, "memory_used_pct");
  const backupAgeHours = getNumber(backups, "latest_backup_age_hours");
  const total5xx = getNumber(apiTraffic, "total_5xx") || 0;
  const smwStatus = String(smw.status || "unknown").toLowerCase();
  const git = asRecord(asRecord(payload.meta).git);

  if (badServices.length || smwStatus === "down" || smwStatus === "critical") status = "critical";
  if (diskUsedPct !== null && diskUsedPct >= 90) status = "critical";
  if (memoryUsedPct !== null && memoryUsedPct >= 95) status = "critical";
  if (total5xx >= 20) status = "critical";
  if (backupAgeHours !== null && backupAgeHours >= 36 && status !== "critical") status = "degraded";
  if (diskUsedPct !== null && diskUsedPct >= 80 && status === "healthy") status = "degraded";
  if (total5xx > 0 && status === "healthy") status = "degraded";

  return {
    status,
    summary: {
      bad_services: badServices,
      disk_used_pct: diskUsedPct,
      memory_used_pct: memoryUsedPct,
      latest_backup_age_hours: backupAgeHours,
      smw_status: smwStatus,
      total_5xx: total5xx,
      branch: git.branch || null,
      sha: git.sha || null,
      request_events: Array.isArray(payload.request_events) ? payload.request_events.length : 0,
    },
  };
}

async function upsertKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
    .bind(key, JSON.stringify(value), nowIso()).run();
}

async function sendAlert(env: Env, text: string): Promise<void> {
  try {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    } else if (env.ALERT_WEBHOOK_URL) {
      await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    }
  } catch {}
}

async function createOrKeepIncident(env: Env, status: Status, source: string, summary: Record<string, unknown>): Promise<void> {
  if (status === "healthy" || status === "unknown") return;
  const open = await env.DB.prepare("SELECT id FROM incidents WHERE status = 'open' AND source = ? ORDER BY started_at DESC LIMIT 1").bind(source).first<{ id: string }>();
  if (open) return;
  const title = status === "critical" ? "SMW critical health issue" : "SMW degraded health issue";
  await env.DB.prepare("INSERT INTO incidents (id, title, severity, status, source, started_at, summary, metadata_json) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)")
    .bind(uuid(), title, status, source, nowIso(), JSON.stringify(summary), JSON.stringify({ created_by: "ops-engine" })).run();
  await sendAlert(env, `🚨 <b>${title}</b>\nSource: <code>${source}</code>\nSeverity: <b>${status}</b>\nSummary: <code>${JSON.stringify(summary).slice(0, 900)}</code>`);
}

async function resolveOpenIncidents(env: Env, source: string, note: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT id FROM incidents WHERE status = 'open' AND source = ?").bind(source).all<{ id: string }>();
  for (const row of rows.results || []) {
    await env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    await sendAlert(env, `✅ <b>Incident resolved</b>\nSource: <code>${source}</code>\n${note}`);
  }
}

async function recordApiTraffic(env: Env, heartbeatId: string, source: string, collectedAt: string, raw: Record<string, unknown>): Promise<void> {
  if (!Object.keys(raw).length) return;
  await env.DB.prepare("INSERT INTO api_traffic_summaries (id, heartbeat_id, source, collected_at, window_seconds, total_requests, total_2xx, total_3xx, total_4xx, total_5xx, top_paths_json, status_codes_json, methods_json, slow_paths_json, privacy_mode, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), heartbeatId, source, collectedAt, Number(raw.window_seconds || 3600), Number(raw.total_requests || 0), Number(raw.total_2xx || 0), Number(raw.total_3xx || 0), Number(raw.total_4xx || 0), Number(raw.total_5xx || 0), JSON.stringify(raw.top_paths || []), JSON.stringify(raw.status_codes || {}), JSON.stringify(raw.methods || {}), JSON.stringify(raw.slow_paths || []), String(raw.privacy_mode || "aggregate"), JSON.stringify(raw.metadata || {})).run();
}

async function recordDeploy(env: Env, heartbeatId: string, source: string, collectedAt: string, meta: Record<string, unknown>): Promise<void> {
  const git = asRecord(meta.git);
  if (!Object.keys(git).length) return;
  const sha = typeof git.sha === "string" ? git.sha : null;
  await env.DB.prepare("INSERT INTO deploy_snapshots (id, heartbeat_id, source, collected_at, branch, sha, short_sha, is_dirty, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), heartbeatId, source, collectedAt, git.branch || null, sha, sha ? sha.slice(0, 12) : null, git.is_dirty ? 1 : 0, JSON.stringify(git)).run();
}

async function recordServer(env: Env, heartbeatId: string, source: string, hostname: string, collectedAt: string, resources: Record<string, unknown>): Promise<void> {
  const load = Array.isArray(resources.load_avg) ? resources.load_avg : [];
  await env.DB.prepare("INSERT INTO server_snapshots (id, heartbeat_id, source, collected_at, hostname, disk_used_pct, memory_used_pct, load1, load5, load15, uptime_seconds, cpu_count, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), heartbeatId, source, collectedAt, hostname, getNumber(resources, "disk_used_pct"), getNumber(resources, "memory_used_pct"), load[0] ?? null, load[1] ?? null, load[2] ?? null, getNumber(resources, "uptime_seconds"), getNumber(resources, "cpu_count"), JSON.stringify(resources)).run();
}

async function recordBackup(env: Env, backups: Record<string, unknown>): Promise<void> {
  if (!Object.keys(backups).length) return;
  await env.DB.prepare("INSERT INTO backup_checks (id, checked_at, status, latest_backup_path, latest_backup_age_hours, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(uuid(), nowIso(), String(backups.status || "unknown"), backups.latest_backup_path || null, getNumber(backups, "latest_backup_age_hours"), JSON.stringify(backups)).run();
}

async function recordErrorGroups(env: Env, rawErrors: Record<string, unknown>): Promise<void> {
  const groups = Array.isArray(rawErrors.groups) ? rawErrors.groups : [];
  for (const raw of groups) {
    const group = asRecord(raw);
    const fingerprint = String(group.fingerprint || "unknown");
    const now = nowIso();
    await env.DB.prepare("INSERT INTO error_groups (id, fingerprint, status, first_seen, last_seen, count, latest_message, latest_traceback, latest_request_id, latest_path, latest_severity, metadata_json) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET last_seen=excluded.last_seen, count=count+excluded.count, latest_message=excluded.latest_message, latest_traceback=excluded.latest_traceback, latest_request_id=excluded.latest_request_id, latest_path=excluded.latest_path, latest_severity=excluded.latest_severity, metadata_json=excluded.metadata_json")
      .bind(uuid(), fingerprint, now, now, Number(group.count || 1), String(group.message || fingerprint).slice(0, 1000), group.traceback || null, group.request_id || null, group.path || null, String(group.severity || "error"), JSON.stringify(group)).run();
  }
}

async function recordRequestEvents(env: Env, heartbeatId: string, source: string, events: unknown[]): Promise<void> {
  if (!events.length) return;
  const roles: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const endpoints: Record<string, number> = {};
  const ips = new Set<string>();
  const users = new Set<string>();
  const slow: Record<string, unknown>[] = [];
  const receivedAt = nowIso();

  for (const raw of events.slice(0, 500)) {
    const ev = asRecord(raw);
    const method = String(ev.method || "GET").slice(0, 10);
    const endpoint = String(ev.endpoint || "/").slice(0, 220);
    const status = Number(ev.status || 0);
    const duration = Number(ev.duration_ms || 0);
    const role = String(ev.role || "unknown").slice(0, 40);
    const hashedIp = typeof ev.hashed_ip === "string" ? ev.hashed_ip : null;
    const hashedUser = typeof ev.hashed_user_id === "string" ? ev.hashed_user_id : null;
    if (hashedIp) ips.add(hashedIp);
    if (hashedUser) users.add(hashedUser);
    roles[role] = (roles[role] || 0) + 1;
    statuses[String(status)] = (statuses[String(status)] || 0) + 1;
    endpoints[endpoint] = (endpoints[endpoint] || 0) + 1;
    if (duration >= 1000) slow.push({ method, endpoint, status, duration_ms: duration, request_id: ev.request_id || null });
    await env.DB.prepare("INSERT INTO request_events (id, heartbeat_id, source, ts, received_at, request_id, method, endpoint, status, duration_ms, role, hashed_user_id, hashed_ip, user_agent_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), heartbeatId, source, String(ev.ts || receivedAt), receivedAt, ev.request_id || null, method, endpoint, status, duration, role, hashedUser, hashedIp, ev.user_agent_hash || null, JSON.stringify({ privacy: "hashed" })).run();
  }

  const topEndpoints = Object.entries(endpoints).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([endpoint, count]) => ({ endpoint, count }));
  await env.DB.prepare("INSERT INTO request_event_summaries (id, heartbeat_id, source, collected_at, window_seconds, total_events, unique_ip_hashes, unique_user_hashes, roles_json, endpoints_json, statuses_json, slow_events_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), heartbeatId, source, receivedAt, 3600, events.length, ips.size, users.size, JSON.stringify(roles), JSON.stringify(topEndpoints), JSON.stringify(statuses), JSON.stringify(slow.slice(0, 20))).run();
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const authError = requireBearer(request, env.AGENT_TOKEN);
  if (authError) return authError;
  let payload: AgentPayload;
  try { payload = (await request.json()) as AgentPayload; } catch { return json({ detail: "Invalid JSON payload." }, { status: 400 }); }

  const source = payload.source || "smw-droplet";
  const hostname = payload.hostname || "unknown";
  const receivedAt = nowIso();
  const { status, summary } = summarizePayload(payload);
  const heartbeatId = uuid();

  await env.DB.prepare("INSERT INTO heartbeats (id, source, hostname, status, received_at, generated_at, payload_json, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(heartbeatId, source, hostname, status, receivedAt, payload.generated_at || null, JSON.stringify(payload), JSON.stringify(summary)).run();

  const services = asRecord(payload.services);
  for (const [name, raw] of Object.entries(services)) {
    const item = asRecord(raw);
    await env.DB.prepare("INSERT INTO service_snapshots (id, heartbeat_id, service_name, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(uuid(), heartbeatId, name, String(item.status || raw || "unknown"), JSON.stringify(item), receivedAt).run();
  }

  await recordApiTraffic(env, heartbeatId, source, receivedAt, asRecord(payload.api_traffic));
  await recordDeploy(env, heartbeatId, source, receivedAt, asRecord(payload.meta));
  await recordServer(env, heartbeatId, source, hostname, receivedAt, asRecord(payload.resources));
  await recordBackup(env, asRecord(payload.backups));
  await recordErrorGroups(env, asRecord(payload.errors));
  await recordRequestEvents(env, heartbeatId, source, Array.isArray(payload.request_events) ? payload.request_events : []);

  await upsertKv(env.DB, "latest_heartbeat", { id: heartbeatId, source, hostname, status, received_at: receivedAt, summary });
  if (status === "healthy") await resolveOpenIncidents(env, source, "Latest heartbeat is healthy.");
  await createOrKeepIncident(env, status, source, summary);
  return json({ ok: true, id: heartbeatId, status, received_at: receivedAt });
}

async function handleLatest(env: Env): Promise<Response> {
  const heartbeat = await env.DB.prepare("SELECT id, source, hostname, status, received_at, generated_at, summary_json FROM heartbeats ORDER BY received_at DESC LIMIT 1").first();
  const uptime = await env.DB.prepare("SELECT target_key, target_url, checked_at, ok, status_code, latency_ms, error FROM uptime_checks ORDER BY checked_at DESC LIMIT 20").all();
  const incidents = await env.DB.prepare("SELECT id, title, severity, status, source, started_at, resolved_at, summary FROM incidents WHERE status = 'open' ORDER BY started_at DESC LIMIT 10").all();
  const deploy = await env.DB.prepare("SELECT branch, sha, short_sha, is_dirty, collected_at FROM deploy_snapshots ORDER BY collected_at DESC LIMIT 1").first();
  const server = await env.DB.prepare("SELECT hostname, disk_used_pct, memory_used_pct, load1, load5, load15, uptime_seconds, cpu_count, collected_at FROM server_snapshots ORDER BY collected_at DESC LIMIT 1").first();
  const apiTraffic = await env.DB.prepare("SELECT collected_at, window_seconds, total_requests, total_2xx, total_3xx, total_4xx, total_5xx, top_paths_json, status_codes_json, methods_json, slow_paths_json, privacy_mode FROM api_traffic_summaries ORDER BY collected_at DESC LIMIT 1").first();
  const backup = await env.DB.prepare("SELECT checked_at, status, latest_backup_path, latest_backup_age_hours, metadata_json FROM backup_checks ORDER BY checked_at DESC LIMIT 1").first();
  const requestSummary = await env.DB.prepare("SELECT collected_at, total_events, unique_ip_hashes, unique_user_hashes, roles_json, endpoints_json, statuses_json, slow_events_json FROM request_event_summaries ORDER BY collected_at DESC LIMIT 1").first();
  const requestEvents = await env.DB.prepare("SELECT ts, request_id, method, endpoint, status, duration_ms, role, hashed_user_id, hashed_ip FROM request_events ORDER BY ts DESC LIMIT 30").all();
  return json({ heartbeat, uptime: uptime.results || [], incidents: incidents.results || [], deploy, server, api_traffic: apiTraffic, backup, request_summary: requestSummary, request_events: requestEvents.results || [] });
}

async function handleServices(env: Env): Promise<Response> {
  const latest = await env.DB.prepare("SELECT id FROM heartbeats ORDER BY received_at DESC LIMIT 1").first<{ id: string }>();
  if (!latest) return json({ services: [] });
  const services = await env.DB.prepare("SELECT service_name, status, detail, checked_at FROM service_snapshots WHERE heartbeat_id = ? ORDER BY service_name ASC").bind(latest.id).all();
  return json({ heartbeat_id: latest.id, services: services.results || [] });
}

async function handleIncidents(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, title, severity, status, source, started_at, resolved_at, summary, metadata_json FROM incidents ORDER BY started_at DESC LIMIT 50").all();
  return json({ incidents: rows.results || [] });
}

async function resolveIncident(request: Request, env: Env, id: string): Promise<Response> {
  const authError = requireBearer(request, env.AGENT_TOKEN);
  if (authError) return authError;
  await env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return json({ ok: true, id });
}

async function handleErrors(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, fingerprint, status, first_seen, last_seen, count, latest_message, latest_request_id, latest_path, latest_severity FROM error_groups ORDER BY last_seen DESC LIMIT 50").all();
  return json({ error_groups: rows.results || [] });
}

async function checkTarget(env: Env, targetKey: string, targetUrl: string): Promise<void> {
  const started = Date.now();
  let ok = 0;
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const headers: Record<string, string> = { "user-agent": "ops-engine/0.3" };
    if (targetKey === "smw-health-summary" && env.SMW_HEALTH_SUMMARY_TOKEN) headers.authorization = `Bearer ${env.SMW_HEALTH_SUMMARY_TOKEN}`;
    const response = await fetch(targetUrl, { method: "GET", headers });
    statusCode = response.status;
    ok = response.ok ? 1 : 0;
  } catch (exc) { error = exc instanceof Error ? exc.message : "unknown fetch error"; }
  const latency = Date.now() - started;
  await env.DB.prepare("INSERT INTO uptime_checks (id, target_key, target_url, checked_at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), targetKey, targetUrl, nowIso(), ok, statusCode, latency, error).run();
  const source = `uptime:${targetKey}`;
  if (ok) await resolveOpenIncidents(env, source, `Target recovered with HTTP ${statusCode}.`);
  else await createOrKeepIncident(env, "critical", source, { target_key: targetKey, target_url: targetUrl, status_code: statusCode, error, latency_ms: latency });
}

async function runScheduledChecks(env: Env): Promise<void> {
  if (env.SMW_PUBLIC_URL) await checkTarget(env, "smw-public", env.SMW_PUBLIC_URL);
  if (env.SMW_HEALTH_SUMMARY_URL) await checkTarget(env, "smw-health-summary", env.SMW_HEALTH_SUMMARY_URL);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (path === "/" || path === "/api") return json({ name: env.APP_NAME || "Ops Engine", status: "ok", version: "0.3" });
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
    try { return withCors(await route(request, env), env); }
    catch (exc) { return withCors(json({ detail: "Internal error", error: exc instanceof Error ? exc.message : "unknown" }, { status: 500 }), env); }
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> { await runScheduledChecks(env); },
};
