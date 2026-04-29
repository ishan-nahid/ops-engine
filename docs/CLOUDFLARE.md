# Cloudflare Deployment Notes

## Worker

Root directory:

```text
apps/worker
```

Deploy manually first:

```bash
cd apps/worker
npm install
cp wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler d1 create ops-engine
# paste database_id into wrangler.toml
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put SMW_HEALTH_SUMMARY_TOKEN
npm run db:migrate:remote
npm run deploy
```

## Pages

Root directory:

```text
apps/dashboard
```

Build command:

```bash
npm run build
```

Build output:

```text
dist
```

Environment variable:

```env
VITE_OPS_API_BASE=https://<worker-domain>/api
```

## Custom domain plan

Recommended final domain:

```text
ops.sunnysir.com
```

Options:

1. Use Cloudflare Pages for the dashboard and a Worker route under `/api/*`.
2. Or keep Worker on `*.workers.dev` first, then move to a route later.

## Access control

Before production, protect the Pages dashboard with Cloudflare Access.

Minimum policy:

```text
allow only your email address
require one-time PIN or Google login
```

Do not make the dashboard public if it includes operational details.
