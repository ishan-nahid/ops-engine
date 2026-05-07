# NOC Dashboard

Ops Engine exposes a dedicated Network Operations Center dashboard at:

```text
https://ops-engine.pages.dev/NOC
```

The NOC dashboard is intentionally separate from the main mission-control dashboard and the SOC dashboard.

## Purpose

The NOC dashboard focuses on availability, infrastructure health, service health, and operational response.

SOC answers:

```text
Are we being attacked or probed?
```

NOC answers:

```text
Is production healthy and available?
```

## Route implementation

The route is implemented as a Cloudflare Pages static asset:

```text
apps/dashboard/public/NOC/index.html
```

Shared static page helpers live in:

```text
apps/dashboard/public/ops-page/ops-page.css
apps/dashboard/public/ops-page/ops-page.js
```

This follows the incremental refactor direction: reusable shared helpers for standalone operational pages, without forcing a full React router refactor yet.

## Data source

The NOC page reads from the existing Worker API:

```text
https://ops-engine-api.ishan4rs.workers.dev/api
```

It uses:

```text
GET /api/status/latest
GET /api/services
GET /api/history
GET /api/incidents
GET /api/errors
```

## NOC coverage

The dashboard surfaces:

- NOC risk score
- SMW health status
- disk usage
- memory usage
- Celery/Redis queue depth
- open incidents
- server load trends
- request and 5xx trends
- recent uptime checks
- systemd and PM2 service snapshots
- PostgreSQL connections, size, lock waits, and slow active query count
- worker and beat service state
- deployment branch/SHA/dirty state
- backup age and backup status

## Privacy boundary

NOC should not show private student data, raw request bodies, cookies, auth headers, raw email content, or payment card data.

NOC is allowed to display operational aggregates and service-level metadata such as service names, status, resource percentages, queue depth, backup age, deployment SHA, database aggregate stats, and uptime result summaries.

## Local validation

```bash
cd apps/dashboard
npm install
npm run build
npm run preview
```

Open:

```text
http://127.0.0.1:4173/NOC/
```

Validate the Worker API directly if needed:

```bash
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/status/latest | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/services | python3 -m json.tool
curl -s https://ops-engine-api.ishan4rs.workers.dev/api/history | python3 -m json.tool
```

## Production validation

After Cloudflare Pages deploys from `main`, check:

```text
https://ops-engine.pages.dev/NOC
```

Hard refresh if needed:

```text
Ctrl + Shift + R
```

## Future improvements

Recommended follow-ups:

- convert Mission Control, SOC, and NOC into shared React page components
- add `/api/noc/summary` if server-side NOC aggregation becomes necessary
- add incident acknowledgement and maintenance-window states
- add backup freshness alert thresholds per environment
- add deploy comparison against expected branch/SHA
- add Cloudflare Analytics data for edge availability and latency
- protect all operational pages with Cloudflare Access
