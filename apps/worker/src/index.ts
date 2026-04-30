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
type Rec = Record<string, unknown>;

type AgentPayload = {
  source?: string;
  hostname?: string;
  generated_at?: string;
  services?: Rec;
  resources?: Rec;
  backups?: Rec;
  smw?: Rec;
  business?: Rec;
  database?: Rec;
  queue?: Rec;
  deployment?: Rec;
  user_experience?: Rec;
  errors?: Rec;
  security?: Rec;
  meta?: Rec;
  api_traffic?: Rec;
  request_events?: unknown[];
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const asRecord = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const num = (o: Rec, k: string): number | null => {
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data, null, 2), { ...init, headers: { ...jsonHeaders, ...(init.headers || {}) } });

function corsHeaders(env: Env): Record<string, string> {
  return { "access-control-allow-origin": env.PUBLIC_DASHBOARD_ORIGIN || "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type", "access-control-max-age": "86400" };
}
function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function requireBearer(request: Request, expected?: string): Response | null {
  if (!expected) return json({ detail: "Server is missing required token configuration." }, { status: 503 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return token && token === expected ? null : json({ detail: "Not found." }, { status: 404 });
}
function parsePayload(row: any): AgentPayload {
  try { return row?.payload_json ? JSON.parse(row.payload_json) : {}; } catch { return {}; }
}
function controlCenterFromPayload(payload: AgentPayload) {
  return {
    production: { status: "live", services: payload.services || {}, resources: payload.resources || {}, smw: payload.smw || {} },
    deployment: payload.deployment || asRecord(payload.meta)?.git || {},
    infrastructure: { status: "live", resources: payload.resources || {}, services: payload.services || {} },
    database: payload.database || {},
    queue: payload.queue || {},
    business: payload.business || {},
    security: payload.security || {},
    user_experience: payload.user_experience || {},
    errors: payload.errors || {},
    agent: { version: asRecord(payload.meta).agent_version || null, generated_at: payload.generated_at || null, source: payload.source || null, hostname: payload.hostname || null },
  };
}
function summarizePayload(payload: AgentPayload): { status: Status; summary: Rec } {
  const services = asRecord(payload.services), resources = asRecord(payload.resources), backups = asRecord(payload.backups), smw = asRecord(payload.smw), api = asRecord(payload.api_traffic);
  const bad: string[] = [];
  for (const [name, raw] of Object.entries(services)) {
    const item = asRecord(raw);
    const s = String(item.status || raw || "unknown").toLowerCase();
    if (!["active", "ok", "running", "online", "healthy"].includes(s)) bad.push(name);
  }
  const disk = num(resources, "disk_used_pct"), mem = num(resources, "memory_used_pct"), backupAge = num(backups, "latest_backup_age_hours"), total5xx = num(api, "total_5xx") || 0;
  const smwStatus = String(smw.status || "unknown").toLowerCase();
  const git = asRecord(asRecord(payload.meta).git);
  let status: Status = "healthy";
  if (bad.length || smwStatus === "down" || smwStatus === "critical" || (disk ?? 0) >= 90 || (mem ?? 0) >= 95 || total5xx >= 20) status = "critical";
  else if ((backupAge ?? 0) >= 36 || (disk ?? 0) >= 80 || total5xx > 0) status = "degraded";
  return { status, summary: { bad_services: bad, disk_used_pct: disk, memory_used_pct: mem, latest_backup_age_hours: backupAge, smw_status: smwStatus, total_5xx: total5xx, branch: git.branch || null, sha: git.sha || null, request_events: Array.isArray(payload.request_events) ? payload.request_events.length : 0 } };
}
async function alert(env: Env, text: string) {
  try {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }) });
    else if (env.ALERT_WEBHOOK_URL) await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {}
}
async function resolveOpen(env: Env, source: string, note: string) {
  const rows = await env.DB.prepare("SELECT id FROM incidents WHERE status='open' AND source=?").bind(source).all<{ id: string }>();
  for (const r of rows.results || []) {
    await env.DB.prepare("UPDATE incidents SET status='resolved', resolved_at=? WHERE id=?").bind(nowIso(), r.id).run();
    await alert(env, `✅ <b>Incident resolved</b>\nSource: <code>${source}</code>\n${note}`);
  }
}
async function createIncident(env: Env, status: Status, source: string, summary: Rec) {
  if (status === "healthy" || status === "unknown") return;
  const open = await env.DB.prepare("SELECT id FROM incidents WHERE status='open' AND source=? LIMIT 1").bind(source).first();
  if (open) return;
  const title = status === "critical" ? "SMW critical health issue" : "SMW degraded health issue";
  await env.DB.prepare("INSERT INTO incidents (id,title,severity,status,source,started_at,summary,metadata_json) VALUES (?,?,?,'open',?,?,?,?)").bind(uuid(), title, status, source, nowIso(), JSON.stringify(summary), JSON.stringify({ created_by: "ops-engine" })).run();
  await alert(env, `🚨 <b>${title}</b>\nSource: <code>${source}</code>\nSeverity: <b>${status}</b>\nSummary: <code>${JSON.stringify(summary).slice(0, 900)}</code>`);
}
async function upsertKv(env: Env, key: string, value: unknown) {
  await env.DB.prepare("INSERT INTO kv_state (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at").bind(key, JSON.stringify(value), nowIso()).run();
}
async function recordApi(env: Env, heartbeatId: string, source: string, at: string, raw: Rec) {
  if (!Object.keys(raw).length) return;
  await env.DB.prepare("INSERT INTO api_traffic_summaries (id,heartbeat_id,source,collected_at,window_seconds,total_requests,total_2xx,total_3xx,total_4xx,total_5xx,top_paths_json,status_codes_json,methods_json,slow_paths_json,privacy_mode,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(uuid(), heartbeatId, source, at, Number(raw.window_seconds || 3600), Number(raw.total_requests || 0), Number(raw.total_2xx || 0), Number(raw.total_3xx || 0), Number(raw.total_4xx || 0), Number(raw.total_5xx || 0), JSON.stringify(raw.top_paths || []), JSON.stringify(raw.status_codes || {}), JSON.stringify(raw.methods || {}), JSON.stringify(raw.slow_paths || []), String(raw.privacy_mode || "aggregate"), JSON.stringify(raw.metadata || {})).run();
}
async function recordDeploy(env: Env, heartbeatId: string, source: string, at: string, meta: Rec) {
  const git = asRecord(meta.git); if (!Object.keys(git).length) return;
  const sha = typeof git.sha === "string" ? git.sha : null;
  await env.DB.prepare("INSERT INTO deploy_snapshots (id,heartbeat_id,source,collected_at,branch,sha,short_sha,is_dirty,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)").bind(uuid(), heartbeatId, source, at, git.branch || null, sha, sha ? sha.slice(0, 12) : null, git.is_dirty ? 1 : 0, JSON.stringify(git)).run();
}
async function recordServer(env: Env, heartbeatId: string, source: string, hostname: string, at: string, resources: Rec) {
  const load = Array.isArray(resources.load_avg) ? resources.load_avg : [];
  await env.DB.prepare("INSERT INTO server_snapshots (id,heartbeat_id,source,collected_at,hostname,disk_used_pct,memory_used_pct,load1,load5,load15,uptime_seconds,cpu_count,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(uuid(), heartbeatId, source, at, hostname, num(resources, "disk_used_pct"), num(resources, "memory_used_pct"), load[0] ?? null, load[1] ?? null, load[2] ?? null, num(resources, "uptime_seconds"), num(resources, "cpu_count"), JSON.stringify(resources)).run();
}
async function recordBackup(env: Env, backups: Rec) {
  if (!Object.keys(backups).length) return;
  await env.DB.prepare("INSERT INTO backup_checks (id,checked_at,status,latest_backup_path,latest_backup_age_hours,metadata_json) VALUES (?,?,?,?,?,?)").bind(uuid(), nowIso(), String(backups.status || "unknown"), backups.latest_backup_path || null, num(backups, "latest_backup_age_hours"), JSON.stringify(backups)).run();
}
async function recordErrors(env: Env, raw: Rec) {
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  for (const g0 of groups) {
    const g = asRecord(g0), fp = String(g.fingerprint || "unknown"), at = nowIso();
    await env.DB.prepare("INSERT INTO error_groups (id,fingerprint,status,first_seen,last_seen,count,latest_message,latest_traceback,latest_request_id,latest_path,latest_severity,metadata_json) VALUES (?,?,'open',?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET last_seen=excluded.last_seen,count=count+excluded.count,latest_message=excluded.latest_message,latest_traceback=excluded.latest_traceback,latest_request_id=excluded.latest_request_id,latest_path=excluded.latest_path,latest_severity=excluded.latest_severity,metadata_json=excluded.metadata_json").bind(uuid(), fp, at, at, Number(g.count || 1), String(g.message || fp).slice(0, 1000), g.traceback || null, g.request_id || null, g.path || null, String(g.severity || "error"), JSON.stringify(g)).run();
  }
}
async function recordRequests(env: Env, heartbeatId: string, source: string, events: unknown[]) {
  if (!events.length) return;
  const roles: Rec = {}, statuses: Rec = {}, endpoints: Record<string, number> = {}, ips = new Set<string>(), users = new Set<string>(), slow: Rec[] = [];
  const receivedAt = nowIso(); let inserted = 0;
  for (const raw of events.slice(0, 500)) {
    const ev = asRecord(raw), method = String(ev.method || "GET").slice(0, 10), endpoint = String(ev.endpoint || "/").slice(0, 220), status = Number(ev.status || 0), duration = Number(ev.duration_ms || 0), role = String(ev.role || "unknown").slice(0, 40);
    const requestId = typeof ev.request_id === "string" ? ev.request_id : null, hashedIp = typeof ev.hashed_ip === "string" ? ev.hashed_ip : null, hashedUser = typeof ev.hashed_user_id === "string" ? ev.hashed_user_id : null;
    if (hashedIp) ips.add(hashedIp); if (hashedUser) users.add(hashedUser);
    roles[role] = Number(roles[role] || 0) + 1; statuses[String(status)] = Number(statuses[String(status)] || 0) + 1; endpoints[endpoint] = (endpoints[endpoint] || 0) + 1;
    if (duration >= 1000) slow.push({ method, endpoint, status, duration_ms: duration, request_id: requestId });
    const result = await env.DB.prepare("INSERT OR IGNORE INTO request_events (id,heartbeat_id,source,ts,received_at,request_id,method,endpoint,status,duration_ms,role,hashed_user_id,hashed_ip,user_agent_hash,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(uuid(), heartbeatId, source, String(ev.ts || receivedAt), receivedAt, requestId, method, endpoint, status, duration, role, hashedUser, hashedIp, ev.user_agent_hash || null, JSON.stringify({ privacy: "hashed" })).run();
    inserted += Number(result.meta?.changes || 0);
  }
  const top = Object.entries(endpoints).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([endpoint, count]) => ({ endpoint, count }));
  await env.DB.prepare("INSERT INTO request_event_summaries (id,heartbeat_id,source,collected_at,window_seconds,total_events,unique_ip_hashes,unique_user_hashes,roles_json,endpoints_json,statuses_json,slow_events_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(uuid(), heartbeatId, source, receivedAt, 3600, inserted, ips.size, users.size, JSON.stringify(roles), JSON.stringify(top), JSON.stringify(statuses), JSON.stringify(slow.slice(0, 20))).run();
}
async function heartbeat(request: Request, env: Env) {
  const auth = requireBearer(request, env.AGENT_TOKEN); if (auth) return auth;
  let payload: AgentPayload; try { payload = await request.json(); } catch { return json({ detail: "Invalid JSON payload." }, { status: 400 }); }
  const source = payload.source || "smw-droplet", hostname = payload.hostname || "unknown", at = nowIso(), id = uuid();
  const { status, summary } = summarizePayload(payload);
  await env.DB.prepare("INSERT INTO heartbeats (id,source,hostname,status,received_at,generated_at,payload_json,summary_json) VALUES (?,?,?,?,?,?,?,?)").bind(id, source, hostname, status, at, payload.generated_at || null, JSON.stringify(payload), JSON.stringify(summary)).run();
  for (const [name, raw] of Object.entries(asRecord(payload.services))) {
    const item = asRecord(raw);
    await env.DB.prepare("INSERT INTO service_snapshots (id,heartbeat_id,service_name,status,detail,checked_at) VALUES (?,?,?,?,?,?)").bind(uuid(), id, name, String(item.status || raw || "unknown"), JSON.stringify(item), at).run();
  }
  await recordApi(env, id, source, at, asRecord(payload.api_traffic)); await recordDeploy(env, id, source, at, asRecord(payload.meta)); await recordServer(env, id, source, hostname, at, asRecord(payload.resources)); await recordBackup(env, asRecord(payload.backups)); await recordErrors(env, asRecord(payload.errors)); await recordRequests(env, id, source, Array.isArray(payload.request_events) ? payload.request_events : []);
  await upsertKv(env, "latest_heartbeat", { id, source, hostname, status, received_at: at, summary });
  if (status === "healthy") await resolveOpen(env, source, "Latest heartbeat is healthy.");
  await createIncident(env, status, source, summary);
  return json({ ok: true, id, status, received_at: at });
}
async function latest(env: Env) {
  const heartbeat = await env.DB.prepare("SELECT id,source,hostname,status,received_at,generated_at,payload_json,summary_json FROM heartbeats ORDER BY received_at DESC LIMIT 1").first<any>();
  const payload = parsePayload(heartbeat);
  if (heartbeat) delete heartbeat.payload_json;
  const uptime = await env.DB.prepare("SELECT target_key,target_url,checked_at,ok,status_code,latency_ms,error FROM uptime_checks ORDER BY checked_at DESC LIMIT 20").all();
  const incidents = await env.DB.prepare("SELECT id,title,severity,status,source,started_at,resolved_at,summary FROM incidents WHERE status='open' ORDER BY started_at DESC LIMIT 10").all();
  const deploy = await env.DB.prepare("SELECT branch,sha,short_sha,is_dirty,collected_at FROM deploy_snapshots ORDER BY collected_at DESC LIMIT 1").first();
  const server = await env.DB.prepare("SELECT hostname,disk_used_pct,memory_used_pct,load1,load5,load15,uptime_seconds,cpu_count,collected_at FROM server_snapshots ORDER BY collected_at DESC LIMIT 1").first();
  const apiTraffic = await env.DB.prepare("SELECT collected_at,window_seconds,total_requests,total_2xx,total_3xx,total_4xx,total_5xx,top_paths_json,status_codes_json,methods_json,slow_paths_json,privacy_mode FROM api_traffic_summaries ORDER BY collected_at DESC LIMIT 1").first();
  const backup = await env.DB.prepare("SELECT checked_at,status,latest_backup_path,latest_backup_age_hours,metadata_json FROM backup_checks ORDER BY checked_at DESC LIMIT 1").first();
  const requestSummary = await env.DB.prepare("SELECT collected_at,total_events,unique_ip_hashes,unique_user_hashes,roles_json,endpoints_json,statuses_json,slow_events_json FROM request_event_summaries ORDER BY collected_at DESC LIMIT 1").first();
  const requestEvents = await env.DB.prepare("SELECT ts,request_id,method,endpoint,status,duration_ms,role,hashed_user_id,hashed_ip FROM request_events ORDER BY ts DESC LIMIT 30").all();
  return json({ heartbeat, control_center: controlCenterFromPayload(payload), uptime: uptime.results || [], incidents: incidents.results || [], deploy, server, api_traffic: apiTraffic, backup, request_summary: requestSummary, request_events: requestEvents.results || [] });
}
async function services(env: Env) {
  const h = await env.DB.prepare("SELECT id FROM heartbeats ORDER BY received_at DESC LIMIT 1").first<{ id: string }>(); if (!h) return json({ services: [] });
  const rows = await env.DB.prepare("SELECT service_name,status,detail,checked_at FROM service_snapshots WHERE heartbeat_id=? ORDER BY service_name ASC").bind(h.id).all();
  return json({ heartbeat_id: h.id, services: rows.results || [] });
}
async function errors(env: Env) { const rows = await env.DB.prepare("SELECT id,fingerprint,status,first_seen,last_seen,count,latest_message,latest_request_id,latest_path,latest_severity FROM error_groups ORDER BY last_seen DESC LIMIT 50").all(); return json({ error_groups: rows.results || [] }); }
async function incidents(env: Env) { const rows = await env.DB.prepare("SELECT id,title,severity,status,source,started_at,resolved_at,summary,metadata_json FROM incidents ORDER BY started_at DESC LIMIT 50").all(); return json({ incidents: rows.results || [] }); }
async function history(env: Env) {
  const server = await env.DB.prepare("SELECT collected_at,hostname,disk_used_pct,memory_used_pct,load1,load5,load15,uptime_seconds,cpu_count FROM server_snapshots ORDER BY collected_at DESC LIMIT 120").all();
  const traffic = await env.DB.prepare("SELECT collected_at,total_requests,total_2xx,total_3xx,total_4xx,total_5xx FROM api_traffic_summaries ORDER BY collected_at DESC LIMIT 120").all();
  const uptime = await env.DB.prepare("SELECT target_key,checked_at,ok,status_code,latency_ms FROM uptime_checks ORDER BY checked_at DESC LIMIT 120").all();
  const requests = await env.DB.prepare("SELECT ts,method,endpoint,status,duration_ms,role FROM request_events ORDER BY ts DESC LIMIT 120").all();
  return json({ server: (server.results || []).reverse(), traffic: (traffic.results || []).reverse(), uptime: (uptime.results || []).reverse(), requests: (requests.results || []).reverse() });
}
async function checkTarget(env: Env, key: string, targetUrl: string) {
  const start = Date.now(); let ok = 0, statusCode: number | null = null, error: string | null = null;
  try {
    const headers: Record<string, string> = { "user-agent": "ops-engine/0.5" };
    if (key === "smw-health-summary" && env.SMW_HEALTH_SUMMARY_TOKEN) headers.authorization = `Bearer ${env.SMW_HEALTH_SUMMARY_TOKEN}`;
    const res = await fetch(targetUrl, { headers }); statusCode = res.status; ok = res.ok ? 1 : 0;
  } catch (e) { error = e instanceof Error ? e.message : "unknown fetch error"; }
  const latency = Date.now() - start;
  await env.DB.prepare("INSERT INTO uptime_checks (id,target_key,target_url,checked_at,ok,status_code,latency_ms,error) VALUES (?,?,?,?,?,?,?,?)").bind(uuid(), key, targetUrl, nowIso(), ok, statusCode, latency, error).run();
  const source = `uptime:${key}`;
  if (ok) await resolveOpen(env, source, `Target recovered with HTTP ${statusCode}.`); else await createIncident(env, "critical", source, { target_key: key, target_url: targetUrl, status_code: statusCode, error, latency_ms: latency });
}
async function route(request: Request, env: Env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (path === "/" || path === "/api") return json({ name: env.APP_NAME || "Ops Engine", status: "ok", version: "0.5" });
  if (path === "/api/agent/heartbeat" && request.method === "POST") return heartbeat(request, env);
  if (path === "/api/status/latest" && request.method === "GET") return latest(env);
  if (path === "/api/services" && request.method === "GET") return services(env);
  if (path === "/api/errors" && request.method === "GET") return errors(env);
  if (path === "/api/incidents" && request.method === "GET") return incidents(env);
  if (path === "/api/history" && request.method === "GET") return history(env);
  if (path === "/api/history/server" && request.method === "GET") { const rows = await env.DB.prepare("SELECT collected_at,hostname,disk_used_pct,memory_used_pct,load1,load5,load15,uptime_seconds,cpu_count FROM server_snapshots ORDER BY collected_at DESC LIMIT 240").all(); return json({ server: (rows.results || []).reverse() }); }
  if (path === "/api/history/traffic" && request.method === "GET") { const rows = await env.DB.prepare("SELECT collected_at,total_requests,total_2xx,total_3xx,total_4xx,total_5xx FROM api_traffic_summaries ORDER BY collected_at DESC LIMIT 240").all(); return json({ traffic: (rows.results || []).reverse() }); }
  if (path === "/api/history/uptime" && request.method === "GET") { const rows = await env.DB.prepare("SELECT target_key,checked_at,ok,status_code,latency_ms FROM uptime_checks ORDER BY checked_at DESC LIMIT 240").all(); return json({ uptime: (rows.results || []).reverse() }); }
  if (path === "/api/history/requests" && request.method === "GET") { const rows = await env.DB.prepare("SELECT ts,method,endpoint,status,duration_ms,role FROM request_events ORDER BY ts DESC LIMIT 240").all(); return json({ requests: (rows.results || []).reverse() }); }
  if (path.startsWith("/api/incidents/") && path.endsWith("/resolve") && request.method === "POST") { const auth = requireBearer(request, env.AGENT_TOKEN); if (auth) return auth; const id = path.split("/")[3]; await env.DB.prepare("UPDATE incidents SET status='resolved', resolved_at=? WHERE id=?").bind(nowIso(), id).run(); return json({ ok: true, id }); }
  if (path === "/api/test-alert" && request.method === "POST") { const auth = requireBearer(request, env.AGENT_TOKEN); if (auth) return auth; await alert(env, "✅ <b>Ops Engine Telegram alert test</b>\nWorker → Telegram is configured correctly."); return json({ ok: true }); }
  return json({ detail: "Not found." }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> { try { return withCors(await route(request, env), env); } catch (e) { return withCors(json({ detail: "Internal error", error: e instanceof Error ? e.message : "unknown" }, { status: 500 }), env); } },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> { if (env.SMW_PUBLIC_URL) await checkTarget(env, "smw-public", env.SMW_PUBLIC_URL); if (env.SMW_HEALTH_SUMMARY_URL) await checkTarget(env, "smw-health-summary", env.SMW_HEALTH_SUMMARY_URL); },
};
