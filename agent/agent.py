#!/usr/bin/env python3
"""Ops Engine droplet agent.

Collects local service/resource health on the SMW droplet and pushes it to the
external Ops Engine Worker. This script opens no public port.

Privacy note: API traffic collection is aggregate-only by default. It does not
send raw IP addresses, emails, cookies, request bodies, or query strings.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_LOG_RE = re.compile(r"api_request\s+(?P<method>[A-Z]+)\s+(?P<path>\S+)\s+(?P<status>\d{3}|None)\s+(?P<duration>\d+)ms")
DJANGO_ERROR_RE = re.compile(r"(?P<level>ERROR|CRITICAL).*?(?P<klass>[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Timeout|Violation))[: ]")


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except ValueError:
        return default


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_cmd(cmd: list[str], timeout: int = 8, cwd: str | None = None) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False, cwd=cwd)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as exc:
        return 999, "", f"{exc.__class__.__name__}: {exc}"


def service_status(name: str) -> dict[str, Any]:
    code, stdout, stderr = run_cmd(["systemctl", "is-active", name], timeout=5)
    status = stdout or "unknown"
    enabled_code, enabled_out, _ = run_cmd(["systemctl", "is-enabled", name], timeout=5)
    return {
        "status": status,
        "ok": code == 0 and status == "active",
        "enabled": enabled_out if enabled_code in (0, 1) else "unknown",
        "error": stderr or None,
    }


def collect_services() -> dict[str, Any]:
    names = [x.strip() for x in env("SERVICE_NAMES").split(",") if x.strip()]
    return {name: service_status(name) for name in names}


def collect_resources() -> dict[str, Any]:
    disk_path = env("DISK_PATH", "/")
    total, used, free = shutil.disk_usage(disk_path)
    disk_used_pct = round((used / total) * 100, 2) if total else None

    mem_total = mem_available = None
    try:
        parsed = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            parsed[key] = int(raw.strip().split()[0]) * 1024
        mem_total = parsed.get("MemTotal")
        mem_available = parsed.get("MemAvailable")
    except Exception:
        pass

    memory_used_pct = None
    if mem_total and mem_available is not None:
        memory_used_pct = round(((mem_total - mem_available) / mem_total) * 100, 2)

    uptime_seconds = None
    try:
        uptime_seconds = int(float(Path("/proc/uptime").read_text().split()[0]))
    except Exception:
        pass

    try:
        load_avg = list(os.getloadavg())
    except Exception:
        load_avg = None

    return {
        "disk_path": disk_path,
        "disk_total_bytes": total,
        "disk_used_bytes": used,
        "disk_free_bytes": free,
        "disk_used_pct": disk_used_pct,
        "memory_total_bytes": mem_total,
        "memory_available_bytes": mem_available,
        "memory_used_pct": memory_used_pct,
        "load_avg": load_avg,
        "uptime_seconds": uptime_seconds,
        "cpu_count": os.cpu_count(),
    }


def collect_pm2() -> dict[str, Any]:
    app_name = env("PM2_APP_NAME")
    if not app_name:
        return {}
    code, stdout, stderr = run_cmd(["pm2", "jlist"], timeout=8)
    if code != 0:
        return {app_name: {"status": "unknown", "ok": False, "error": stderr or stdout}}
    try:
        apps = json.loads(stdout)
    except Exception as exc:
        return {app_name: {"status": "unknown", "ok": False, "error": str(exc)}}
    for app in apps:
        if app.get("name") == app_name:
            env_data = app.get("pm2_env") or {}
            monit = app.get("monit") or {}
            return {
                app_name: {
                    "status": env_data.get("status", "unknown"),
                    "ok": env_data.get("status") == "online",
                    "restart_time": env_data.get("restart_time"),
                    "uptime": env_data.get("pm_uptime"),
                    "memory_bytes": monit.get("memory"),
                    "cpu_pct": monit.get("cpu"),
                }
            }
    return {app_name: {"status": "missing", "ok": False}}


def collect_smw_health() -> dict[str, Any]:
    url = env("SMW_HEALTH_SUMMARY_URL")
    if not url:
        return {"status": "unknown", "error": "SMW_HEALTH_SUMMARY_URL not configured"}
    headers = {"user-agent": "ops-engine-agent/0.2"}
    token = env("SMW_HEALTH_SUMMARY_TOKEN")
    if token:
        headers["authorization"] = f"Bearer {token}"
    timeout = env_int("HTTP_TIMEOUT_SECONDS", 8)
    started = time.monotonic()
    try:
        response = requests.get(url, headers=headers, timeout=timeout)
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            data = response.json()
        except Exception:
            data = {"body": response.text[:300]}
        return {"status": "ok" if response.ok else "down", "ok": response.ok, "status_code": response.status_code, "latency_ms": latency_ms, "data": data}
    except Exception as exc:
        return {"status": "down", "ok": False, "error": f"{exc.__class__.__name__}: {exc}"}


def _backup_dirs() -> list[Path]:
    raw = env("BACKUP_DIRS") or env("BACKUP_DIR")
    dirs = [Path(x.strip()).expanduser() for x in raw.split(",") if x.strip()]
    if dirs:
        return dirs
    candidates = [
        Path("/home/ishan/db_backups"),
        Path("/home/ishan/backups"),
        Path("/home/ishan/backup"),
        Path("/var/backups"),
        Path("/home/ishan/log_exports"),
    ]
    return candidates


def collect_backups() -> dict[str, Any]:
    patterns = [x.strip() for x in env("BACKUP_PATTERNS", "*.sql,*.dump,*.gz,*.backup,*.bak").split(",") if x.strip()]
    max_depth = env_int("BACKUP_MAX_DEPTH", 5)
    files: list[Path] = []
    searched: list[str] = []
    for folder in _backup_dirs():
        searched.append(str(folder))
        if not folder.exists():
            continue
        for pattern in patterns:
            for path in folder.rglob(pattern):
                try:
                    if path.is_file() and len(path.relative_to(folder).parts) <= max_depth:
                        files.append(path)
                except Exception:
                    continue
    if not files:
        return {"status": "missing", "searched_dirs": searched, "latest_backup_age_hours": None}
    latest = max(files, key=lambda p: p.stat().st_mtime)
    age_hours = round((time.time() - latest.stat().st_mtime) / 3600, 2)
    status = "ok" if age_hours <= env_int("BACKUP_OK_HOURS", 24) else "stale" if age_hours <= env_int("BACKUP_STALE_HOURS", 48) else "critical"
    return {
        "status": status,
        "searched_dirs": searched,
        "latest_backup_path": str(latest),
        "latest_backup_age_hours": age_hours,
        "latest_backup_size_bytes": latest.stat().st_size,
        "matched_files": len(files),
    }


def collect_git() -> dict[str, Any]:
    project_dir = env("SMW_PROJECT_DIR")
    if not project_dir:
        return {}
    cwd = Path(project_dir)
    if not cwd.exists():
        return {"error": "SMW_PROJECT_DIR missing"}
    code, sha, err = run_cmd(["git", "rev-parse", "HEAD"], timeout=5, cwd=str(cwd))
    if code != 0:
        return {"error": err or sha}
    branch_code, branch, _ = run_cmd(["git", "branch", "--show-current"], timeout=5, cwd=str(cwd))
    dirty_code, dirty, _ = run_cmd(["git", "status", "--porcelain"], timeout=5, cwd=str(cwd))
    msg_code, msg, _ = run_cmd(["git", "log", "-1", "--pretty=%s"], timeout=5, cwd=str(cwd))
    return {
        "sha": sha,
        "short_sha": sha[:12],
        "branch": branch if branch_code == 0 else None,
        "is_dirty": bool(dirty) if dirty_code == 0 else None,
        "last_commit_message": msg if msg_code == 0 else None,
    }


def journal_lines(unit: str, since: str = "1 hour ago", priority: str | None = None, timeout: int = 8) -> list[str]:
    cmd = ["journalctl", "-u", unit, "--since", since, "--no-pager"]
    if priority:
        cmd.extend(["-p", priority])
    code, stdout, _ = run_cmd(cmd, timeout=timeout)
    if code != 0 and not stdout:
        return []
    return [line for line in stdout.splitlines() if line.strip()]


def _safe_path(raw_path: str) -> str:
    try:
        path = urlsplit(raw_path).path or raw_path.split("?", 1)[0]
    except Exception:
        path = raw_path.split("?", 1)[0]
    parts = [p for p in path.split("/") if p]
    cleaned: list[str] = []
    for part in parts[:6]:
        if part.isdigit() or re.fullmatch(r"[0-9a-fA-F-]{16,}", part):
            cleaned.append(":id")
        else:
            cleaned.append(part[:60])
    return "/" + "/".join(cleaned) if cleaned else "/"


def collect_api_traffic() -> dict[str, Any]:
    lines = journal_lines(env("API_LOG_UNIT", "gunicorn-smw"), env("API_LOG_SINCE", "1 hour ago"), timeout=10)
    total = total_2xx = total_3xx = total_4xx = total_5xx = 0
    paths: Counter[str] = Counter()
    status_codes: Counter[str] = Counter()
    methods: Counter[str] = Counter()
    slow: list[dict[str, Any]] = []
    for line in lines:
        match = API_LOG_RE.search(line)
        if not match:
            continue
        total += 1
        method = match.group("method")
        status_raw = match.group("status")
        duration = int(match.group("duration"))
        status = int(status_raw) if status_raw.isdigit() else 0
        safe_path = _safe_path(match.group("path"))
        paths[safe_path] += 1
        methods[method] += 1
        status_codes[str(status)] += 1
        if 200 <= status < 300:
            total_2xx += 1
        elif 300 <= status < 400:
            total_3xx += 1
        elif 400 <= status < 500:
            total_4xx += 1
        elif status >= 500:
            total_5xx += 1
        if duration >= env_int("SLOW_API_MS", 1000):
            slow.append({"method": method, "path": safe_path, "status": status, "duration_ms": duration})
    slow.sort(key=lambda x: int(x.get("duration_ms", 0)), reverse=True)
    return {
        "privacy_mode": "aggregate",
        "window_seconds": 3600,
        "total_requests": total,
        "total_2xx": total_2xx,
        "total_3xx": total_3xx,
        "total_4xx": total_4xx,
        "total_5xx": total_5xx,
        "top_paths": [{"path": path, "count": count} for path, count in paths.most_common(12)],
        "status_codes": dict(status_codes),
        "methods": dict(methods),
        "slow_paths": slow[:10],
        "metadata": {"source": "journalctl", "unit": env("API_LOG_UNIT", "gunicorn-smw")},
    }


def collect_errors() -> dict[str, Any]:
    checks: dict[str, Any] = {}
    groups: Counter[str] = Counter()
    samples: dict[str, dict[str, Any]] = {}
    for unit in [x.strip() for x in env("ERROR_LOG_UNITS", "gunicorn-smw,celery_smw,nginx").split(",") if x.strip()]:
        lines = journal_lines(unit, env("ERROR_LOG_SINCE", "1 hour ago"), priority="err", timeout=8)
        checks[unit] = {"error_lines_last_hour": len(lines), "sample": lines[-3:] if lines else [], "ok": True}
        for line in lines:
            klass = "LogError"
            match = DJANGO_ERROR_RE.search(line)
            if match:
                klass = match.group("klass")
            path_match = re.search(r"(/api/\S+)", line)
            path = _safe_path(path_match.group(1)) if path_match else None
            fingerprint = f"{unit}:{klass}:{path or '-'}"
            groups[fingerprint] += 1
            samples[fingerprint] = {"fingerprint": fingerprint, "message": line[-900:], "path": path, "severity": "error", "unit": unit}
    return {"units": checks, "groups": [{**samples[k], "count": v} for k, v in groups.most_common(25)]}


def collect_security() -> dict[str, Any]:
    # Aggregate-only security signals. No raw IPs are sent by default.
    nginx_lines = journal_lines("nginx", env("SECURITY_LOG_SINCE", "1 hour ago"), timeout=8)
    fail2ban_lines = journal_lines("fail2ban", env("SECURITY_LOG_SINCE", "1 hour ago"), timeout=8)
    return {
        "privacy_mode": "aggregate",
        "nginx_error_lines": len(nginx_lines),
        "fail2ban_events": len(fail2ban_lines),
        "fail2ban_sample": fail2ban_lines[-5:] if fail2ban_lines else [],
    }


def build_payload() -> dict[str, Any]:
    services = collect_services()
    services.update(collect_pm2())
    return {
        "source": env("OPS_ENGINE_SOURCE", "smw-droplet"),
        "hostname": socket.gethostname(),
        "generated_at": now_iso(),
        "services": services,
        "resources": collect_resources(),
        "backups": collect_backups(),
        "smw": collect_smw_health(),
        "api_traffic": collect_api_traffic(),
        "errors": collect_errors(),
        "security": collect_security(),
        "meta": {"git": collect_git(), "agent_version": "0.2.0"},
    }


def push(payload: dict[str, Any]) -> None:
    url = env("OPS_ENGINE_API_URL")
    token = env("OPS_ENGINE_AGENT_TOKEN")
    if not url or not token:
        raise SystemExit("OPS_ENGINE_API_URL and OPS_ENGINE_AGENT_TOKEN are required")
    timeout = env_int("HTTP_TIMEOUT_SECONDS", 8)
    response = requests.post(url, headers={"authorization": f"Bearer {token}", "content-type": "application/json"}, json=payload, timeout=timeout)
    response.raise_for_status()
    print(response.text)


def main() -> None:
    push(build_payload())


if __name__ == "__main__":
    main()
