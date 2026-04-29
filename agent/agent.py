#!/usr/bin/env python3
"""Ops Engine droplet agent.

Collects local service/resource health on the SMW droplet and pushes it to the
external Ops Engine Worker. This script opens no public port.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_cmd(cmd: list[str], timeout: int = 8) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
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
        meminfo = Path("/proc/meminfo").read_text().splitlines()
        parsed = {}
        for line in meminfo:
            key, raw = line.split(":", 1)
            parsed[key] = int(raw.strip().split()[0]) * 1024
        mem_total = parsed.get("MemTotal")
        mem_available = parsed.get("MemAvailable")
    except Exception:
        pass

    memory_used_pct = None
    if mem_total and mem_available is not None:
        memory_used_pct = round(((mem_total - mem_available) / mem_total) * 100, 2)

    load_avg = None
    try:
        load_avg = list(os.getloadavg())
    except Exception:
        pass

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
            return {
                app_name: {
                    "status": env_data.get("status", "unknown"),
                    "ok": env_data.get("status") == "online",
                    "restart_time": env_data.get("restart_time"),
                    "uptime": env_data.get("pm_uptime"),
                }
            }
    return {app_name: {"status": "missing", "ok": False}}


def collect_smw_health() -> dict[str, Any]:
    url = env("SMW_HEALTH_SUMMARY_URL")
    if not url:
        return {"status": "unknown", "error": "SMW_HEALTH_SUMMARY_URL not configured"}
    headers = {"user-agent": "ops-engine-agent/0.1"}
    token = env("SMW_HEALTH_SUMMARY_TOKEN")
    if token:
        headers["authorization"] = f"Bearer {token}"
    timeout = int(env("HTTP_TIMEOUT_SECONDS", "8") or "8")
    started = time.monotonic()
    try:
        response = requests.get(url, headers=headers, timeout=timeout)
        latency_ms = int((time.monotonic() - started) * 1000)
        data = None
        try:
            data = response.json()
        except Exception:
            data = {"body": response.text[:300]}
        return {
            "status": "ok" if response.ok else "down",
            "ok": response.ok,
            "status_code": response.status_code,
            "latency_ms": latency_ms,
            "data": data,
        }
    except Exception as exc:
        return {"status": "down", "ok": False, "error": f"{exc.__class__.__name__}: {exc}"}


def collect_backups() -> dict[str, Any]:
    backup_dir = env("BACKUP_DIR")
    if not backup_dir:
        return {"status": "unknown", "error": "BACKUP_DIR not configured"}
    path = Path(backup_dir).expanduser()
    if not path.exists():
        return {"status": "missing", "backup_dir": str(path), "latest_backup_age_hours": None}

    files = [p for p in path.rglob("*") if p.is_file()]
    if not files:
        return {"status": "missing", "backup_dir": str(path), "latest_backup_age_hours": None}
    latest = max(files, key=lambda p: p.stat().st_mtime)
    age_hours = round((time.time() - latest.stat().st_mtime) / 3600, 2)
    status = "ok" if age_hours <= 24 else "stale" if age_hours <= 48 else "critical"
    return {
        "status": status,
        "backup_dir": str(path),
        "latest_backup_path": str(latest),
        "latest_backup_age_hours": age_hours,
        "latest_backup_size_bytes": latest.stat().st_size,
    }


def collect_git() -> dict[str, Any]:
    project_dir = env("SMW_PROJECT_DIR")
    if not project_dir:
        return {}
    cwd = Path(project_dir)
    if not cwd.exists():
        return {"error": "SMW_PROJECT_DIR missing"}
    code, sha, err = run_cmd(["git", "rev-parse", "HEAD"], timeout=5)
    if code != 0:
        return {"error": err or sha}
    branch_code, branch, _ = run_cmd(["git", "branch", "--show-current"], timeout=5)
    return {"sha": sha, "branch": branch if branch_code == 0 else None}


def collect_errors() -> dict[str, Any]:
    # Lightweight placeholder. The worker/dashboard can evolve without requiring
    # full log parsing on day one.
    checks: dict[str, Any] = {}
    for unit in ["gunicorn-smw", "celery_smw", "nginx"]:
        code, stdout, stderr = run_cmd(["journalctl", "-u", unit, "--since", "1 hour ago", "-p", "err", "--no-pager"], timeout=8)
        lines = [line for line in stdout.splitlines() if line.strip()]
        checks[unit] = {"error_lines_last_hour": len(lines), "sample": lines[-3:] if lines else [], "ok": code == 0, "error": stderr or None}
    return checks


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
        "errors": collect_errors(),
        "meta": {"git": collect_git(), "agent_version": "0.1.0"},
    }


def push(payload: dict[str, Any]) -> None:
    url = env("OPS_ENGINE_API_URL")
    token = env("OPS_ENGINE_AGENT_TOKEN")
    if not url or not token:
        raise SystemExit("OPS_ENGINE_API_URL and OPS_ENGINE_AGENT_TOKEN are required")
    timeout = int(env("HTTP_TIMEOUT_SECONDS", "8") or "8")
    response = requests.post(
        url,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    response.raise_for_status()
    print(response.text)


def main() -> None:
    payload = build_payload()
    push(payload)


if __name__ == "__main__":
    main()
