# Ops Engine

External mission-control dashboard and observability system for **SMW / sunnysir.com**.

Ops Engine intentionally lives outside the main SMW Django project. It gives SWE, SRE, DevOps, and DevSecOps visibility even when the SMW app is degraded, slow, or unavailable.

> Core rule: **SMW should not own engineering observability.** SMW exposes only a small safe bridge. Ops Engine owns dashboards, history, incidents, alerts, server analytics, error grouping, and operational intelligence.

---

## Current production URLs

| Component | URL |
|---|---|
| Dashboard | `https://ops-engine.pages.dev` |
| Worker API | `https://ops-engine-api.ishan4rs.workers.dev/api` |
| SMW public site | `https://sunnysir.com` |
| SMW private health bridge | `https://sunnysir.com/api/internal/health-summary/` |

The SMW private health bridge should return `404` without the correct bearer token. That is expected.

---

## What Ops Engine replaces

Ops Engine is designed to reduce or replace personal-use dependency on:

- Sentry-style error grouping
- Uptime Kuma-style uptime checks
- Netdata-style server health panels
- ad hoc SSH log review
- Django admin pages for developer-only ops data
- Telegram-only manual alerting

It is not a commercial Sentry/Datadog replacement yet, but it provides the exact operational visibility needed for the SMW stack.

---

## Architecture

```text
SMW Django app
  ├─ /api/internal/health-summary/       private bearer-token health bridge
  ├─ APIAccessLogMiddleware              normal structured API access logs
  └─ OpsEngineRequestTelemetryMiddleware sanitized JSONL request events

DigitalOcean droplet
  └─ ops-engine-agent systemd timer
      ├─ reads systemd/journal logs
      ├─ reads Postgres stats
      ├─ reads Redis/Celery queue depth
      ├─ reads backup age
      ├─ reads fail2ban/nginx/security summaries
      ├─ reads sanitized request JSONL
      └─ pushes heartbeat outward

Cloudflare Worker
  ├─ receives agent heartbeats
  ├─ runs scheduled uptime checks
  ├─ stores history in D1
  ├─ opens/resolves incidents
  ├─ sends Telegram alerts
  └─ exposes dashboard API

Cloudflare Pages dashboard
  └─ reads Worker API and renders mission-control UI
```

Important: the droplet agent **pushes data out**. The SMW droplet should not expose a public monitoring port.

---

## Repository layout

```text
ops-engine/
  apps/
    worker/             Cloudflare Worker API, D1, uptime cron, alerts
    dashboard/          React/Vite dashboard deployed to Cloudflare Pages
  agent/                Python droplet agent + systemd units
  docs/                 setup, architecture, runbooks, notes
  scripts/              install/maintenance scripts
```

---

## Dashboard sections

The dashboard is section-based and includes top navigation:

```text
Overview | Trends | Traffic | Database | Queue | Security | UX | Business | Incidents
```

Target dashboard separation:

```text
Overview = all traffic, including normal 2xx responses
SOC      = suspicious patterns, findings, investigations, and response actions
NOC      = infrastructure and service health
GRC      = compliance and audit evidence
Logs     = searchable sanitized events
Settings = thresholds, allowlists, integrations, and response policy
```

Current live coverage:

| Section | Data source |
|---|---|
| Production Health | Worker uptime checks, agent heartbeat, SMW health summary |
| Server Trends | Droplet resource snapshots from agent |
| API Traffic | Gunicorn journal access logs + sanitized request JSONL |
| Database Monitoring | Postgres `pg_stat_*` collector |
| Queue / Worker Monitoring | Redis `LLEN` + Celery systemd service status |
| Security / DevSecOps | fail2ban/nginx summaries + grouped errors + request risk hints |
| UX / RUM | JSONL RUM contract, ready for browser events |
| Business Impact | SMW health-summary business counters |
| Incidents | Worker D1 incidents + Telegram alert hooks |
| Sentry-lite Errors | Django/Celery journal tracebacks parsed by agent |

---

## Request telemetry contract

SMW writes sanitized backend API events to `REQUEST_EVENTS_JSONL_PATH`. Ops Engine agent preserves and forwards the following safe fields:

```text
ts
request_id
service
source
method
endpoint
route_group
status
status_family
is_success
is_client_error
is_server_error
duration_ms
is_slow
risk_hint
role
hashed_user_id
hashed_ip
user_agent_hash
```

The Worker stores the enriched fields inside `request_events.metadata_json` so no D1 migration is required for this compatibility update. Dashboard APIs return parsed `metadata` for latest and historical request events.

Current lightweight `risk_hint` values from SMW:

```text
none
scanner_probe
admin_probe
server_error
slow_request
```

Important: these are event hints, not automatic blocking decisions. SOC should aggregate them into findings and response recommendations.

---

## Data privacy rules

Ops Engine must never collect or store:

- request bodies
- cookies
- auth headers
- raw IP addresses
- raw user IDs
- payment card data
- private student data
- raw email content

Allowed telemetry:

- hashed IP
- hashed user id
- role
- endpoint path with IDs normalized
- route group
- method
- status code and status family
- duration
- request id
- timestamp
- slow/success/error flags
- risk hint
- service/server/database/queue aggregates
- sanitized traceback metadata from backend logs

---

## Worker API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api` | Worker health/version |
| `POST /api/agent/heartbeat` | Agent heartbeat ingest; requires `AGENT_TOKEN` |
| `GET /api/status/latest` | Dashboard latest summary and normalized `control_center` payload |
| `GET /api/services` | Latest service snapshots |
| `GET /api/errors` | Sentry-lite error groups |
| `GET /api/incidents` | Incident list |
| `POST /api/incidents/:id/resolve` | Resolve incident; requires `AGENT_TOKEN` |
| `GET /api/history` | Combined history for dashboard charts |
| `GET /api/history/server` | Server history |
| `GET /api/history/traffic` | API traffic history |
| `GET /api/history/uptime` | Uptime history |
| `GET /api/history/requests` | Request event history with parsed metadata |
| `POST /api/test-alert` | Telegram alert test; requires `AGENT_TOKEN` |

---

## Local setup

Clone:

```bash
cd ~/Desktop

git clone https://github.com/ishan-nahid/ops-engine.git
cd ops-engine
```

Install root dependencies if needed:

```bash
npm install
```

Worker:

```bash
cd apps/worker
npm install
npm run typecheck
```

Dashboard:

```bash
cd apps/dashboard
npm install
npm run build
```

---

## Cloudflare setup

### 1. Login

```bash
cd apps/worker
npx wrangler login
```

### 2. Create D1 database

```bash
npx wrangler d1 create ops-engine
```

Add the returned `database_id` to `apps/worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ops-engine"
database_id = "<database-id>"
```

### 3. Apply migrations

```bash
npm run db:migrate:remote
```

### 4. Set secrets

```bash
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put SMW_HEALTH_SUMMARY_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 5. Deploy Worker

```bash
npm run deploy
```

Validate:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/status/latest | python3 -m json.tool
```

---

## Dashboard deployment

Dashboard is deployed with Cloudflare Pages.

Recommended Cloudflare Pages settings:

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root directory | `apps/dashboard` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |

Set environment variable:

```text
VITE_OPS_API_BASE=https://ops-engine-api.ishan4rs.workers.dev/api
```

Deploy from `main`. After deployment, hard refresh the browser:

```text
Ctrl + Shift + R
```

---

## Droplet agent setup

The agent runs on the SMW DigitalOcean droplet using systemd timer.

### Install / update agent

```bash
ssh ishan@165.232.191.83

cd /tmp
rm -rf ops-engine
git clone https://github.com/ishan-nahid/ops-engine.git
cd ops-engine

sudo bash scripts/install_agent.sh
```

### Configure agent

Open:

```bash
sudo nano /usr/local/ops-engine-agent/.env
```

Minimum production values:

```env
OPS_ENGINE_API_URL=https://ops-engine-api.ishan4rs.workers.dev/api/agent/heartbeat
OPS_ENGINE_AGENT_TOKEN=<same-value-as-worker-AGENT_TOKEN>
OPS_ENGINE_SOURCE=smw-droplet

SMW_HEALTH_SUMMARY_URL=https://sunnysir.com/api/internal/health-summary/
SMW_HEALTH_SUMMARY_TOKEN=<same-value-as-worker-SMW_HEALTH_SUMMARY_TOKEN>
SMW_PROJECT_DIR=/var/www/html/SMW-v1

SERVICE_NAMES=nginx,gunicorn-smw,celery_smw,celery-beat-smw,postgresql@16-main,redis-server,fail2ban
PM2_APP_NAME=smw-frontend

POSTGRES_COLLECT_ENABLED=true
POSTGRES_DB=smw_db_v2
POSTGRES_USER=smw_app
POSTGRES_PASSWORD=<db-password>
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432

CELERY_QUEUE_NAMES=celery
REDIS_CLI=redis-cli
REDIS_URL=redis://127.0.0.1:6379/0
CELERY_WORKER_SERVICE=celery_smw
CELERY_BEAT_SERVICE=celery-beat-smw

BACKUP_DIRS=/home/ishan/db_backups,/home/ishan/backups,/var/backups
BACKUP_PATTERNS=*.sql,*.dump,*.gz,*.backup,*.bak
BACKUP_OK_HOURS=24
BACKUP_STALE_HOURS=48

API_LOG_UNIT=gunicorn-smw
API_LOG_SINCE="10 minutes ago"
SLOW_API_MS=1000

ERROR_LOG_UNITS=gunicorn-smw,celery_smw,nginx
ERROR_LOG_SINCE="1 hour ago"
SECURITY_LOG_SINCE="1 hour ago"

REQUEST_EVENTS_JSONL_PATH=/var/www/html/SMW-v1/Backend/logs/ops_engine_api_events.jsonl
REQUEST_EVENTS_MAX_SEND=250
REQUEST_EVENTS_WINDOW_SECONDS=3600
RUM_EVENTS_JSONL_PATH=/var/www/html/SMW-v1/Backend/logs/ops_engine_rum_events.jsonl
```

Values with spaces must be quoted if you run `source /usr/local/ops-engine-agent/.env` manually.

### Test dependencies

```bash
which psql
which redis-cli
```

If missing:

```bash
sudo apt update
sudo apt install -y postgresql-client redis-tools
```

### Test DB and Redis

```bash
set -a
source /usr/local/ops-engine-agent/.env
set +a

PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" \
  -p "$POSTGRES_PORT" \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -c "select current_database(), current_user;"

redis-cli -u "$REDIS_URL" LLEN celery
```

### Run agent once

```bash
sudo systemctl start ops-engine-agent.service
sudo journalctl -u ops-engine-agent -n 120 --no-pager
```

Expected:

```json
{
  "ok": true,
  "status": "healthy"
}
```

### Enable timer

```bash
sudo systemctl enable --now ops-engine-agent.timer
systemctl list-timers | grep ops-engine
```

---

## Telegram alert setup

1. Create bot using BotFather.
2. Send any message to the bot.
3. Get chat id:

```bash
read -s TG_BOT_TOKEN
curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates" | python3 -m json.tool
```

4. Store Worker secrets:

```bash
cd apps/worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npm run deploy
```

5. Test:

```bash
read -s AGENT_TOKEN
curl -X POST \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  https://ops-engine-api.ishan4rs.workers.dev/api/test-alert
```

---

## Validation commands

Latest status:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/status/latest | python3 -m json.tool
```

Errors:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/errors | python3 -m json.tool
```

History:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history | python3 -m json.tool
```

Specific history endpoints:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history/server | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history/traffic | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history/uptime | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history/requests | python3 -m json.tool
```

SMW private bridge through public URL:

```bash
SMW_HEALTH_TOKEN='<token>'

curl -i \
  -H "Authorization: Bearer $SMW_HEALTH_TOKEN" \
  https://sunnysir.com/api/internal/health-summary/
```

Unauthenticated should intentionally return `404`.

---

## Common operations

### Deploy Worker

```bash
cd ~/Desktop/ops-engine/ops-engine/apps/worker
npm run deploy
```

### Deploy dashboard

Cloudflare Pages redeploys from `main`. If needed:

```text
Cloudflare → Workers & Pages → ops-engine → Deployments → Retry deployment
```

### Update agent on droplet

```bash
ssh ishan@165.232.191.83

cd /tmp
rm -rf ops-engine
git clone https://github.com/ishan-nahid/ops-engine.git
cd ops-engine

sudo bash scripts/install_agent.sh
sudo systemctl start ops-engine-agent.service
sudo journalctl -u ops-engine-agent -n 80 --no-pager
```

### Clean fake/noisy error groups manually

Only for known bad fingerprints:

```bash
cd apps/worker

npx wrangler d1 execute DB --remote --command "
DELETE FROM error_groups
WHERE fingerprint IN (
  'nginx:LogError:-',
  'celery_smw:LogError:-',
  'gunicorn-smw:LogError:-'
);
"
```

---

## SMW integration boundary

Keep only these in the SMW Django project:

- `/api/internal/health-summary/`
- `APIAccessLogMiddleware`
- `OpsEngineRequestTelemetryMiddleware`
- normal Django/Celery logs

Do not keep these in SMW:

- developer-only ops dashboards
- server resource dashboards
- log review UIs
- app-side Sentry initialization
- app-side Telegram ops alerting
- app-side ErrorEvent persistence for developer monitoring

Ops Engine owns those concerns.

---

## Development notes

### Worker commands

```bash
cd apps/worker
npm run typecheck
npm run db:migrate:local
npm run db:migrate:remote
npm run deploy
```

### Dashboard commands

```bash
cd apps/dashboard
npm run build
npm run dev
npm run preview
```

### Agent commands

```bash
/usr/local/ops-engine-agent/.venv/bin/python /usr/local/ops-engine-agent/agent.py
sudo systemctl start ops-engine-agent.service
sudo journalctl -u ops-engine-agent -n 120 --no-pager
sudo systemctl status ops-engine-agent.timer --no-pager
```

---

## Troubleshooting

### Dashboard is blank

Open browser console. Common causes:

- dashboard bundle is old: hard refresh with `Ctrl + Shift + R`
- Worker API CORS/origin mismatch
- malformed API data shape
- Cloudflare Pages deployed from wrong root directory

### Health summary returns 404

Expected without bearer token. Test with token:

```bash
curl -i -H "Authorization: Bearer <token>" https://sunnysir.com/api/internal/health-summary/
```

### Error groups show `-- No entries --`

This should be fixed by v0.6 installer patch. Reinstall the agent and clean old bad rows:

```bash
sudo bash scripts/install_agent.sh
sudo systemctl start ops-engine-agent.service
```

Then delete known fake fingerprints from D1 if needed.

### Production deploy shows dirty

Check server repo:

```bash
cd /var/www/html/SMW-v1
git status
```

If only runtime logs are dirty, ignore them locally:

```bash
cat >> .git/info/exclude <<'EOF'

# Runtime logs generated on production server
Backend/logs/
EOF
```

Then force an agent heartbeat:

```bash
sudo systemctl start ops-engine-agent.service
```

---

## Roadmap

Planned next improvements:

- GitHub Actions CI/CD ingestion
- Cloudflare Analytics integration
- richer RUM frontend script
- slow query sampling with safer redaction
- retention/pruning jobs for D1
- incident acknowledgement workflow
- dashboard authentication/protection
- custom domain such as `ops.sunnysir.com`
- SOC/NOC/GRC/Logs dashboard split with shared switcher
- request risk-hint aggregation and SOC findings
- private droplet-agent/Cloudflare response bridge
- richer Telegram alert formatting
- runbook links per incident type

---

## Safety reminder

Do not commit secrets. Do not paste tokens into chat or GitHub issues. Use Wrangler secrets and server-side `.env` files only.
