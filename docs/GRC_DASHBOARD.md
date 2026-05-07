# GRC Compliance Readiness Dashboard

Ops Engine exposes a Governance, Risk, and Compliance readiness dashboard at:

```text
https://ops-engine.pages.dev/GRC
```

This dashboard is designed for SOC 2 and ISO 27001-style readiness tracking. It does **not** claim certification. Formal certification requires policies, management approval, audit evidence, access reviews, risk treatment, and external auditor activity.

## Purpose

GRC answers:

```text
Are we ready to prove that the platform is governed, monitored, backed up, reviewed, and risk-managed?
```

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
apps/dashboard/public/GRC/index.html
```

It reuses the shared operational page shell:

```text
apps/dashboard/public/ops-page/ops-page.css
apps/dashboard/public/ops-page/ops-page.js
```

## Data source

The GRC dashboard reads from the existing Worker API:

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

## Current automated readiness signals

The dashboard currently derives evidence from live Ops Engine telemetry:

- production monitoring freshness
- SMW health status
- uptime and availability status
- backup freshness
- deployment branch/SHA/dirty state
- systemd/PM2 service health
- PostgreSQL aggregate health
- Redis/Celery queue health
- fail2ban/nginx/security monitoring summaries
- incident state
- error groups
- 5xx trends
- disk and memory trends

## Compliance-style control groups

The page maps current signals into readiness views for:

### SOC 2-style groups

- Security
- Availability
- Confidentiality
- Processing Integrity
- Privacy

### ISO 27001-style groups

- Information security policies
- Access control
- Operations security
- Incident management
- Business continuity
- Supplier relationships

## Manual controls still required

Some compliance evidence cannot be created from server logs. These remain manual or future D1-backed registry items:

- policy approvals
- production/admin access reviews
- backup restore-test evidence
- vendor reviews
- risk treatment plans
- audit evidence exports
- management acceptance records
- data retention review
- privacy notice review

## Local validation

```bash
cd apps/dashboard
npm install
npm run build
npm run preview
```

Open:

```text
http://127.0.0.1:4173/GRC/
```

## Production validation

After Cloudflare Pages deploys from `main`, open:

```text
https://ops-engine.pages.dev/GRC
```

Hard refresh if needed:

```text
Ctrl + Shift + R
```

## Future implementation phases

### Phase 1: Current PR

- static `/GRC` readiness dashboard
- auto-derived control status from existing Worker API data
- shared ops-page styling and helpers

### Phase 2: Worker D1 registry

Add durable GRC tables:

```text
controls
control_evidence
policy_register
risk_items
access_reviews
vendor_reviews
audit_notes
exceptions
```

### Phase 3: Admin-only evidence actions

Add protected Worker API actions:

- mark evidence reviewed
- record access review
- record backup restore test
- create risk item
- close risk item
- link policy evidence
- export audit packet

### Phase 4: Access protection

Protect all operational pages with Cloudflare Access before exposing them broadly:

```text
/
/SOC
/NOC
/GRC
```
