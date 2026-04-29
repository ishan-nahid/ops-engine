# Setup Guide

This project is Cloudflare-first, but all real Cloudflare values should be added only after you create the Cloudflare resources.

## 1. Cloudflare Worker API

```bash
cd apps/worker
npm install
cp wrangler.toml.example wrangler.toml
```

Create a D1 database:

```bash
npx wrangler d1 create ops-engine
```

Copy the returned database id into `apps/worker/wrangler.toml`.

Set secrets:

```bash
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put SMW_HEALTH_SUMMARY_TOKEN
```

Apply migrations:

```bash
npm run db:migrate:remote
```

Deploy:

```bash
npm run deploy
```

## 2. Cloudflare Pages dashboard

```bash
cd apps/dashboard
npm install
npm run build
```

Cloudflare Pages settings:

```text
Build command: npm run build
Build output directory: dist
Root directory: apps/dashboard
```

Environment variable:

```env
VITE_OPS_API_BASE=https://your-worker-domain.workers.dev/api
```

After custom domain setup, use:

```env
VITE_OPS_API_BASE=https://ops.sunnysir.com/api
```

## 3. SMW Django project env vars

In SMW-v1 backend `.env`, add later:

```env
SMW_OPS_DASHBOARD_URL=https://ops.sunnysir.com
SMW_HEALTH_SUMMARY_TOKEN=the-same-secret-used-by-worker-or-agent
```

Then deploy/restart SMW.

## 4. Install droplet agent

On the SMW droplet:

```bash
cd /tmp
git clone https://github.com/ishan-nahid/ops-engine.git
cd ops-engine
sudo bash scripts/install_agent.sh
sudo nano /usr/local/ops-engine-agent/.env
```

Edit:

```env
OPS_ENGINE_API_URL=https://your-worker-domain.workers.dev/api/agent/heartbeat
OPS_ENGINE_AGENT_TOKEN=the-worker-agent-token
SMW_HEALTH_SUMMARY_URL=http://127.0.0.1:8001/api/internal/health-summary/
SMW_HEALTH_SUMMARY_TOKEN=optional-if-loopback
BACKUP_DIR=/home/ishan/db_backups
```

Test once:

```bash
sudo systemctl start ops-engine-agent.service
sudo journalctl -u ops-engine-agent -n 80 --no-pager
```

Enable timer:

```bash
sudo systemctl enable --now ops-engine-agent.timer
systemctl list-timers | grep ops-engine
```

## 5. Verify

Worker API:

```bash
curl https://your-worker-domain.workers.dev/api/status/latest
```

Dashboard:

```text
Open the Cloudflare Pages URL.
```

Agent logs:

```bash
sudo journalctl -u ops-engine-agent -f
```

## 6. Production hardening checklist

- protect the dashboard with Cloudflare Access
- keep `AGENT_TOKEN` long and random
- never commit `wrangler.toml` if it contains real IDs/secrets
- keep `.env` permission `600` on the droplet
- confirm no new inbound port was opened
- configure Better Stack heartbeat as a backup watcher
