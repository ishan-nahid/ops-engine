# Ops Engine Architecture

Ops Engine is the external mission-control system for SMW.

## Goals

- stay usable when the SMW Django app is degraded
- avoid adding public monitoring ports to the DigitalOcean droplet
- keep engineering/ops analytics outside the main SMW business app
- provide a small Sentry-lite, Uptime-Kuma-lite, and Netdata-lite experience over time

## Components

```text
SMW DigitalOcean droplet
  agent/agent.py
    systemd service + timer
    collects service/resource/app health
    pushes HTTPS heartbeat outward

Cloudflare Worker
  /api/agent/heartbeat
  /api/status/latest
  /api/services
  /api/incidents
  /api/errors
  scheduled uptime checks

Cloudflare D1
  heartbeats
  service_snapshots
  uptime_checks
  incidents
  error_groups
  backup_checks

Cloudflare Pages
  dashboard UI
```

## Data flow

```text
SMW droplet agent
  -> POST /api/agent/heartbeat
  -> Worker validates AGENT_TOKEN
  -> Worker stores heartbeat + services in D1
  -> Worker opens incident if status is degraded/critical
  -> Dashboard reads latest state from Worker API
```

## Security model

- no inbound monitoring port on the SMW droplet
- agent uses outbound HTTPS only
- agent heartbeat endpoint requires a bearer token
- SMW `/api/internal/health-summary/` should require a token for non-loopback access
- dashboard should be protected with Cloudflare Access before production use

## Non-goals for v1

- storing raw logs in D1
- mutating SMW business data
- restarting services from the dashboard
- replacing full Sentry/Netdata immediately

## Later upgrades

- Telegram/Slack alerts
- Sentry-lite error grouping from structured SMW logs
- backup verification details
- deploy SHA timeline
- Cloudflare Access-protected admin actions
- read-only runbook command generator
