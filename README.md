# Ops Engine

External mission-control dashboard for SMW (`sunnysir.com`).

This repository intentionally lives outside the main SMW Django project. It is designed to answer operational questions when SMW is degraded or unavailable.

## Architecture

- `apps/worker` — Cloudflare Worker API, D1 access, cron uptime checks, alert hooks
- `apps/dashboard` — Cloudflare Pages dashboard frontend
- `agent` — Python droplet agent that pushes server/service health outward
- `docs` — setup, deployment, architecture, and runbooks

## First target deployment

- Dashboard: Cloudflare Pages
- API: Cloudflare Workers
- Storage: Cloudflare D1
- Server collector: Python systemd timer on the SMW DigitalOcean droplet

## Main rule

The agent pushes data out. The SMW droplet should not expose a public monitoring port.

## Quick local map

```text
ops-engine/
  apps/
    worker/
    dashboard/
  agent/
  docs/
  scripts/
```

See `docs/SETUP.md` for the setup order.
