const OpsPage = (() => {
  const API_BASE = window.OPS_ENGINE_API_BASE || localStorage.getItem("OPS_ENGINE_API_BASE") || "https://ops-engine-api.ishan4rs.workers.dev/api";
  const $ = (id) => document.getElementById(id);
  const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const asArray = (value) => Array.isArray(value) ? value : [];
  const parseJson = (value, fallback) => {
    if (typeof value !== "string") return value || fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch]));
  const ago = (iso) => {
    if (!iso) return "never";
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return "unknown";
    const sec = Math.max(0, Math.round(diff / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  };
  const fmtBytes = (bytes) => {
    const b = n(bytes, -1);
    if (b < 0) return "—";
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  };
  const fmtUptime = (seconds) => {
    const s = n(seconds, -1);
    if (s < 0) return "—";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const statusClass = (value) => {
    const s = String(value || "unknown").toLowerCase();
    if (["healthy","ok","active","running","online","live","enabled"].includes(s)) return "good";
    if (["degraded","warning","pending","stale","stale-warning","partial"].includes(s)) return "warn";
    if (["critical","failed","down","inactive","error","missing","disabled"].includes(s)) return "bad";
    const code = Number(s);
    if (Number.isFinite(code)) return code >= 500 ? "bad" : code >= 400 ? "warn" : "good";
    return "unknown";
  };
  const metric = (title, value, detail, tone = "") => `<div class="metric ${tone}"><p>${esc(title)}</p><strong>${esc(value)}</strong><span>${esc(detail || "")}</span></div>`;
  const statusRow = (name, status, detail) => `<article class="status-row"><span class="dot ${statusClass(status)}"></span><div><strong>${esc(name)}</strong><p>${esc(status)}${detail ? " · " + esc(detail) : ""}</p></div></article>`;
  const bars = (id, rows) => {
    const el = $(id); if (!el) return;
    const data = rows.length ? rows : [{ label: "none", value: 0 }];
    const max = Math.max(...data.map(x => n(x.value)), 1);
    el.innerHTML = data.map(row => `<div class="bar-row"><span class="bar-label" title="${esc(row.label)}">${esc(row.label)}</span><div class="bar-track"><div class="bar-fill ${row.tone || ""}" style="width:${Math.max(2, n(row.value) / max * 100)}%"></div></div><span class="bar-value">${esc(row.value)}</span></div>`).join("");
  };
  const downsample = (values, maxPoints = 48) => {
    const nums = asArray(values).map(Number).filter(Number.isFinite);
    if (nums.length <= maxPoints) return nums;
    const bucket = nums.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i += 1) {
      const start = Math.floor(i * bucket);
      const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
      const slice = nums.slice(start, end);
      out.push(Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)));
    }
    return out;
  };
  const spark = (id, label, values, tone = "", suffix = "") => {
    const el = $(id); if (!el) return;
    const raw = asArray(values).map(Number).filter(Number.isFinite);
    const nums = downsample(raw, 48);
    const latest = raw.length ? raw[raw.length - 1] : 0;
    const max = Math.max(...nums, 1), min = Math.min(...nums, 0), span = Math.max(1, max - min);
    const points = nums.length ? nums.map((v, i) => `${(i / Math.max(1, nums.length - 1)) * 100},${44 - ((v - min) / span) * 34}`).join(" ") : "0,44 100,44";
    el.innerHTML = `<div class="spark-box"><div class="spark-head"><strong>${esc(label)}</strong><span>${raw.length ? `${latest}${suffix}` : "0"}</span></div><svg class="spark ${tone}" viewBox="0 0 100 52" preserveAspectRatio="none"><polyline points="${points}"></polyline></svg></div>`;
  };
  const getJson = async (path) => {
    const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  };
  const loadBundle = async () => {
    const [latest, services, history, incidents, errors] = await Promise.all([
      getJson("/status/latest"), getJson("/services"), getJson("/history"), getJson("/incidents"), getJson("/errors"),
    ]);
    return { latest, services, history, incidents, errors };
  };
  return { API_BASE, $, n, asArray, parseJson, esc, ago, fmtBytes, fmtUptime, statusClass, metric, statusRow, bars, spark, getJson, loadBundle };
})();
