# SOC Dashboard

Ops Engine exposes a dedicated Security Operations Center dashboard at:

```text
https://ops-engine.pages.dev/SOC
```

The SOC dashboard is intentionally separate from the main Mission Control dashboard. Mission Control remains focused on broad production, SRE, database, queue, UX, and business health. SOC focuses on security triage, suspicious traffic, risk hints, fail2ban/security signals, and incident investigation.

## Current production navigation

All operational dashboards should link to each other with a shared top-level dashboard switcher:

```text
Mission Control | SOC | NOC | GRC
```

Current routes:

```text
/      = Mission Control
/SOC   = Security Operations Center
/NOC   = Network Operations Center
/GRC   = Governance, Risk, and Compliance readiness
```

The SOC page also exposes intra-page links:

```text
Signals | Suspicious Requests | Privacy
```

The 2026-05-13 deployed SOC screenshot confirms that the SOC page shows the global dashboard links and marks `SOC` as active.

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
- route-group distributions
- request-role distributions
- risk-hint distributions
- top endpoint pressure
- open incidents
- Sentry-lite backend/Celery error groups
- sampled request events with hashed identifiers only

## Request risk hints

SMW emits lightweight `risk_hint` values in sanitized request telemetry. Current values:

```text
none
scanner_probe
admin_probe
server_error
slow_request
```

SOC treats these as triage hints, not automatic blocking decisions.

Current interpretation:

| Risk hint | Meaning | Default action |
|---|---|---|
| `none` | No known suspicious pattern | No action |
| `scanner_probe` | Common scanner path such as wp-admin, swagger, credentials, config, etc. | Observe unless repeated/heavy |
| `admin_probe` | Admin or secret-admin probing pattern | Review; challenge/block only if repeated |
| `server_error` | Backend/server-side failure signal | Investigate |
| `slow_request` | Request exceeded slow threshold | Review for abuse/performance issue |

## SOC scoring model

The SOC score is risk-hint aware. It should avoid treating ordinary one-off internet scanner noise as a critical incident.

Current scoring behavior:

```text
scanner_probe: +2 each, capped at +25
admin_probe: +8 each, capped at +40
server_error: +15 each
slow_request: +5 each, capped at +25
5xx: +15 each
fail2ban bans: +20 each
nginx error lines: +2 each, capped at +20
open incidents: +25 each
error groups: +8 each
```

Recommended action logic:

```text
Clear        = no meaningful suspicious signals
Observe      = failed scanner-only activity
Review       = mixed higher-risk signals, admin probe, slow abuse, or score >= 55
Challenge    = repeated admin probing or fail2ban activity
Investigate  = incidents, repeated server errors, or significant 5xx activity
```

## Fail2ban interpretation note

The current agent exposes aggregate fail2ban event and ban counts. This may include SSH activity, nginx-sensitive-probe activity, nginx botsearch activity, or other jail activity depending on the logs seen inside the agent window.

Important implication:

```text
Fail2ban bans are useful SOC context, but they do not always mean the web application is under active HTTP attack.
```

If the SOC score becomes elevated mainly because of fail2ban bans, verify which jail caused them on the droplet:

```bash
sudo fail2ban-client status
sudo fail2ban-client status sshd
sudo fail2ban-client status nginx-sensitive-probes
sudo fail2ban-client status nginx-botsearch
sudo fail2ban-client status nginx-http-auth
sudo grep -Ei "nginx-sensitive-probes|nginx-botsearch|nginx-http-auth|sshd|Ban|Unban|Found|Ignore" /var/log/fail2ban.log | tail -n 120
```

Recommended future improvement:

```text
Expose per-jail fail2ban counters from the agent so SOC can weigh nginx/http bans higher and sshd bans lower.
```

Suggested future weighting:

```text
nginx-sensitive-probes ban: +20 each
nginx-botsearch ban: +10 each
nginx-http-auth ban: +10 each
sshd ban: +3 each, capped at +15
```

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
- route group
- risk hint
- method
- status code and status family
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

Expected visible items:

- global dashboard links: `Mission Control | SOC | NOC | GRC`
- SOC active navigation state
- SOC risk score
- scanner/admin/server/fail2ban/error cards
- risk-hint bars
- status-code bars
- route-group bars
- suspicious request table with `Risk` column
- incidents/error groups
- privacy boundary cards

## Future improvements

Recommended follow-up improvements:

- split fail2ban counters by jail in the agent and Worker response
- move SOC UI into React components after the main dashboard is split into reusable components
- add `/api/security/summary` in the Worker if SOC-specific server-side aggregation becomes necessary
- add incident acknowledgement and analyst notes
- add Cloudflare Analytics/security-event integration
- add retention and pruning rules for request-event summaries
- protect the dashboard with Cloudflare Access before exposing sensitive operational visibility broadly
