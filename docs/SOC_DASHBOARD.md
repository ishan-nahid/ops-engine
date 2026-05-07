# SOC Dashboard

Ops Engine exposes a dedicated Security Operations Center dashboard at:

```text
https://ops-engine.pages.dev/SOC
```

The SOC dashboard is intentionally separate from the main mission-control dashboard. The main dashboard remains focused on production, SRE, database, queue, UX, and business health. The SOC dashboard focuses on security triage and incident investigation.

## Route implementation

The route is implemented as a static Cloudflare Pages asset:

```text
apps/dashboard/public/SOC/index.html
```

Vite copies files from `apps/dashboard/public/` into the build output. Cloudflare Pages can therefore serve `/SOC` directly as a folder index route without adding a React router dependency or refactoring the existing single-page dashboard.

## Data source

The SOC page reads from the existing Worker API:

```text
https://ops-engine-api.ishan4rs.workers.dev/api
```

It uses these endpoints:

```text
GET /api/status/latest
GET /api/errors
```

The dashboard consumes the same sanitized data already pushed by the SMW droplet agent:

- fail2ban event counts and ban/unban summaries
- nginx error-line summaries
- API 4xx and 5xx counts
- status-code distributions
- request-role distributions
- top endpoint pressure
- open incidents
- Sentry-lite backend/Celery error groups
- sampled request events with hashed identifiers only

## Privacy boundary

The SOC dashboard must not display or require:

- raw IP addresses
- raw user IDs
- request bodies
- cookies
- authorization headers
- payment card data
- private student data
- raw email content

Allowed SOC fields include:

- hashed IP
- hashed user ID
- user role
- normalized endpoint path
- method
- status code
- request duration
- request ID
- incident metadata
- sanitized traceback metadata

## Local validation

```bash
cd apps/dashboard
npm install
npm run build
```

Preview locally:

```bash
npm run preview
```

Then open:

```text
http://127.0.0.1:4173/SOC/
```

If the local preview cannot reach the production Worker API due to browser/network settings, validate the Worker API directly:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/status/latest | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/errors | python3 -m json.tool
```

## Deployment validation

After Cloudflare Pages deploys from `main`, check:

```text
https://ops-engine.pages.dev/SOC
```

Hard refresh the browser if needed:

```text
Ctrl + Shift + R
```

## Future improvements

Recommended follow-up improvements:

- move SOC UI into React components after the main dashboard is split into reusable components
- add `/api/security/summary` in the Worker if SOC-specific server-side aggregation becomes necessary
- add incident acknowledgement and analyst notes
- add Cloudflare Analytics/security-event integration
- add retention and pruning rules for request-event summaries
- protect the dashboard with Cloudflare Access before exposing sensitive operational visibility broadly
