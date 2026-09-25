# Bilky automation

Production provider: **Airtop**.

## Runtime architecture

- Cloudflare Worker cron: every 5 minutes.
- Worker dispatches up to 5 independent GitHub Actions attempts inside the configured Europe/Madrid window.
- One GitHub run = one attempt.
- Stop immediately after a successful run.
- Airtop session uses:
  - Spain proxy
  - sticky session
  - CAPTCHA solver enabled
  - 2 minute server-side timeout

## Production flow

1. Open the direct Workshift URL.
2. If Bilky redirects to login, fill TaxID and password.
3. Submit the login form.
4. From Dashboard open Workshift Control.
5. Read the existing Morning/Evening fact before any click.
6. If the fact already exists, return `already_done` and do not click.
7. Otherwise click the target clock button.
8. Require POST `/employee/hour-registration/clock-hour` with HTTP 200.
9. Save commit proof and diagnostics.
10. Send Telegram result.

## Active workflows

- `.github/workflows/workshift-production.yml` - production clock operation.
- `.github/workflows/status-report.yml` - read-only weekly status.

## Active source files

- `src/production-core.js` - Airtop browser/navigation and production logic.
- `src/workshift.js` - production entrypoint.
- `src/status-core.js` - Airtop read-only status navigation.
- `src/status.js` - weekly status report.

Obsolete Browserless/Bright Data/smoke-test implementations are not part of the active repository.
