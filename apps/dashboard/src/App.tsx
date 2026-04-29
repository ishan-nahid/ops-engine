import React, { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Database, HardDrive, RefreshCw, Server, ShieldAlert, WifiOff } from "lucide-react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ApiEnvelope = {
  heartbeat?: any;
  uptime?: any[];
  incidents?: any[];
};

type ServiceEnvelope = {
  heartbeat_id?: string;
  services?: any[];
};

const API_BASE = import.meta.env.VITE_OPS_API_BASE || "/api";

function statusClass(status?: string | null): string {
  const value = String(status || "unknown").toLowerCase();
  if (["healthy", "ok", "active", "running", "online"].includes(value)) return "good";
  if (["degraded", "warning", "pending"].includes(value)) return "warn";
  if (["critical", "failed", "down", "inactive", "error"].includes(value)) return "bad";
  return "unknown";
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatAgo(iso?: string): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "unknown";
  const seconds = Math.max(0, Math.round(diff / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function MetricCard({ title, value, detail, icon, tone }: { title: string; value: React.ReactNode; detail?: React.ReactNode; icon: React.ReactNode; tone?: string }) {
  return (
    <section className={`metric ${tone || ""}`}>
      <div className="metricIcon">{icon}</div>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
    </section>
  );
}

function App() {
  const [latest, setLatest] = useState<ApiEnvelope | null>(null);
  const [services, setServices] = useState<ServiceEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [latestPayload, servicePayload] = await Promise.all([
        fetchJson<ApiEnvelope>("/status/latest"),
        fetchJson<ServiceEnvelope>("/services"),
      ]);
      setLatest(latestPayload);
      setServices(servicePayload);
      setLastRefresh(new Date().toISOString());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Unable to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const heartbeat = latest?.heartbeat || null;
  const summary = useMemo(() => parseJson(heartbeat?.summary_json), [heartbeat]);
  const status = String(heartbeat?.status || "unknown");
  const openIncidents = latest?.incidents || [];
  const uptime = latest?.uptime || [];
  const serviceRows = services?.services || [];

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">SMW Mission Control</p>
          <h1>Ops Engine</h1>
          <p className="subtitle">External operational dashboard for sunnysir.com. The droplet agent pushes health data outward; this page should remain useful even when SMW is degraded.</p>
        </div>
        <button className="refresh" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={18} /> Refresh
        </button>
      </header>

      {error ? (
        <section className="banner bad">
          <WifiOff size={18} /> Unable to load Ops Engine API: {error}
        </section>
      ) : null}

      <section className="grid metrics">
        <MetricCard title="Overall status" value={status.toUpperCase()} detail={`Last heartbeat ${formatAgo(heartbeat?.received_at)}`} icon={statusClass(status) === "good" ? <CheckCircle2 /> : <AlertTriangle />} tone={statusClass(status)} />
        <MetricCard title="Host" value={heartbeat?.hostname || "unknown"} detail={heartbeat?.source || "no source yet"} icon={<Server />} />
        <MetricCard title="Disk used" value={summary?.disk_used_pct != null ? `${summary.disk_used_pct}%` : "—"} detail="from latest agent heartbeat" icon={<HardDrive />} tone={summary?.disk_used_pct >= 90 ? "bad" : summary?.disk_used_pct >= 80 ? "warn" : ""} />
        <MetricCard title="Memory used" value={summary?.memory_used_pct != null ? `${summary.memory_used_pct}%` : "—"} detail="from latest agent heartbeat" icon={<Activity />} tone={summary?.memory_used_pct >= 95 ? "bad" : summary?.memory_used_pct >= 85 ? "warn" : ""} />
        <MetricCard title="Backup age" value={summary?.latest_backup_age_hours != null ? `${summary.latest_backup_age_hours}h` : "—"} detail="latest detected backup" icon={<Database />} tone={summary?.latest_backup_age_hours >= 36 ? "warn" : ""} />
        <MetricCard title="Open incidents" value={openIncidents.length} detail={lastRefresh ? `updated ${formatAgo(lastRefresh)}` : "not refreshed"} icon={<ShieldAlert />} tone={openIncidents.length ? "bad" : "good"} />
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Service Health</p>
            <h2>Latest service snapshots</h2>
          </div>
          <span className="muted">Heartbeat: {services?.heartbeat_id || "none"}</span>
        </div>
        <div className="tableWrap">
          <table>
            <thead><tr><th>Service</th><th>Status</th><th>Checked</th><th>Detail</th></tr></thead>
            <tbody>
              {serviceRows.length ? serviceRows.map((svc, idx) => (
                <tr key={`${svc.service_name}-${idx}`}>
                  <td>{svc.service_name}</td>
                  <td><span className={`pill ${statusClass(svc.status)}`}>{svc.status}</span></td>
                  <td>{formatAgo(svc.checked_at)}</td>
                  <td><code>{JSON.stringify(parseJson(svc.detail)).slice(0, 110)}</code></td>
                </tr>
              )) : <tr><td colSpan={4}>No service snapshots yet. Install the droplet agent first.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="twoCol">
        <section className="panel">
          <div className="panelHeader"><div><p className="eyebrow">Incidents</p><h2>Open incidents</h2></div></div>
          <div className="stack">
            {openIncidents.length ? openIncidents.map((item) => (
              <article className="incident" key={item.id}>
                <span className={`pill ${statusClass(item.severity)}`}>{item.severity}</span>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                <small>{item.source} · {formatAgo(item.started_at)}</small>
              </article>
            )) : <p className="muted">No open incidents.</p>}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader"><div><p className="eyebrow">Uptime</p><h2>Recent checks</h2></div><Clock size={18} /></div>
          <div className="stack">
            {uptime.length ? uptime.slice(0, 10).map((item, idx) => (
              <article className="uptime" key={`${item.target_key}-${idx}`}>
                <span className={`dot ${item.ok ? "good" : "bad"}`} />
                <div>
                  <strong>{item.target_key}</strong>
                  <p>{item.status_code || "—"} · {item.latency_ms ?? "—"}ms · {formatAgo(item.checked_at)}</p>
                  {item.error ? <small>{item.error}</small> : null}
                </div>
              </article>
            )) : <p className="muted">No uptime checks yet. Deploy the Worker cron after configuring Cloudflare.</p>}
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
