# Live API checks

Five scripts that drive a running API the way the portal and the agents do, and two that check the 3.1 migrations and the speed of the team month report. Together they make 686 checks, and all of them pass on the 3.1 code:

| Script | Checks | Covers |
| --- | --- | --- |
| `followups.live.mjs` | 25 | One person's current presence, Assign shifts hiding empty departments, no reason asked of a Super Admin, agent password sign-in marking the agent activated |
| `breaks.live.mjs` | 101 | Shifts, assignments, the break flow (windows, reasons, overrun), approvals and their routing, 2.x agents, team view, End Day |
| `hardening.live.mjs` | 23 | Health, login lockout, password change and reset, socket checks, input validation |
| `v31.live.mjs` | 378 | 3.1 end to end with 3.1 and 3.0 agents: Start Day, End Day (answering with the day it ended), resume and two-session focus; skip and every refusal; comments; the End Day gates (a Manager's overdue approvals, then skip comments); overruns asked, left out, from a 3.0 agent and reopening a decided break; live and logged meetings (a discarded one stays discarded); the unified approvals (filters, sort, scopes, bulk approve, reopen, who decided); the month lock (`MONTH_NOT_ENDED`, `OPEN_SESSIONS`, `PENDING_APPROVALS`, `MONTH_LOCKED`); a missed End Day closed at the last input with its later auto-skips removed, and `lastEnded` within 12 hours; settings; activity for managers only (the report ack, current app, analytics and productivity too); `NOT_STARTED`; Team today; reports, scope and the Excel export |
| `simulate-month.live.mjs` | 124 | Writes a realistic September 2026 (2 managers, 10 staff and a night-shift agent, about 160,000 activity samples) and checks it through the API: focus against the SPEC 1.3 formula on sampled days, day classes at the 80 % and 40 % boundaries, the night shift (each night one working day dated the evening it began, a meeting after midnight, a missed End Day, the hours after midnight on the evening's heatmap row), month and team totals, scope, the Excel export, the month lock |
| `migrations.live.mjs` | 27 | No API needed. Builds a scratch copy of the local database with the 3.0 schema and 3.0 rows for every backfill case, applies the two 3.1 migrations with `prisma migrate deploy` one at a time (timed), checks the result (including a day that already has a session and a grace and a lunch changed after the schema migration, as on a database that ran an earlier version), runs the backfill a second time to check it changes nothing, and drops the copy. `VOLUME=5` adds about 5 million activity samples to time the backfill |
| `perf-team-month.live.mjs` | 8 | Writes August 2026 for 100 people (about 1.3 million samples) and times the team month report; a second run on the same database only times it. `BUDGET_MS` (default 1500) is the slowest median accepted |

In 3.1, two checks in `followups.live.mjs` changed with SPEC 3.9: before anyone starts the day, presence is `NOT_STARTED` (it was `WORKING`).

They rely on the seeded demo accounts and they change data: they end days, change the demo manager's password, pause sign-in for the demo staff account for 15 minutes, and add people. So:

- Run them only against a local or staging database you can wipe. Never production: `lib.mjs` refuses the production API host.
- Start each script on a freshly reset database and a freshly started API (the login lockout lives in the API's memory).
- `v31.live.mjs`, `simulate-month.live.mjs` and `perf-team-month.live.mjs` also write to the database directly (through `@prisma/client`) for what no API can do: a skip left from yesterday, an item made overdue, a day in an earlier month, a whole simulated month. `migrations.live.mjs` creates its own scratch database beside the local one and drops it at the end. They read `DATABASE_URL` from the environment or `backend/.env`, and refuse to run unless it points at `localhost`.
- `v31.live.mjs` builds shifts around the current time, so run it between 02:05 and 20:54 business time. It takes about two minutes (it waits a minute for breaks to run over).
- `simulate-month.live.mjs` leaves September 2026 in place for screenshots (with 5 items still waiting for a decision) and prints the sign-in details of the simulated people. Running it twice on one database is refused: reset first.

## Run

Node 20 or later. In `backend/`:

```bash
# 1. Wipe the database, re-apply the migrations and seed the demo data
npx prisma migrate reset --force
#    (staging with NODE_ENV=production: SEED_DEMO_DATA=true npx prisma migrate reset --force)

# 2. Start the API (a second terminal), and wait for "RX Vision API on ..."
npm run start:dev

# 3. Run one script
node test/live/followups.live.mjs
```

Repeat steps 1 to 3 for `breaks.live.mjs`, `hardening.live.mjs`, `v31.live.mjs`, `simulate-month.live.mjs` and `perf-team-month.live.mjs`. Each ends with `N passed, 0 failed` and exits with a non-zero code if any check fails. `migrations.live.mjs` needs neither a reset nor the API (it works on its own scratch database next to the local one).

`hardening.live.mjs` takes its socket client from the portal, so run `npm ci` in `web-portal` once first.

## Settings

| Variable | Default | Note |
| --- | --- | --- |
| `API` | `http://localhost:4000/api/v1` | The API under test |
| `APP_TIMEZONE` | `Asia/Kolkata` | Must equal the API's: `breaks.live.mjs` and `v31.live.mjs` build shifts around the current time in that zone |
| `DATABASE_URL` | from `backend/.env` | `v31.live.mjs`, `simulate-month.live.mjs`, `migrations.live.mjs` and `perf-team-month.live.mjs` only; must point at `localhost` |
