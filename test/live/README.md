# Live API checks

Scripts that drive a running API the way the portal and the agents do. They change data, so run them only against a local or staging database you can wipe; `lib.mjs` refuses the production API host, and `db.mjs` refuses any database that is not on this machine.

## 4.0 (the release gate)

| Script | Checks | Covers | Needs |
| --- | --- | --- | --- |
| `v40-lead.live.mjs` | 111 | Settings and calendar per organisation, quick breaks (and in Team breaks), pause and resume, the paid allowance, away answers and their approval (a late second answer, `event`, any-case approval paths), a department with no manager (its items wait for the Admin; team reports by `departmentId`), MoM sender, History, Team (agent version) and Overview, the timesheet (JSON and Excel), offline replay, and a 3.1 agent against the 4.0 API | A freshly reset and seeded database (run it first); Monday to Saturday between 02:00 and 19:00 IST; it creates its own extra people through the Admin |
| `v40-offline.live.mjs` | 32 | A two-hour offline day replayed with event times: offline with no activity data until the queued samples follow the journal, then the day as it happened, paid time, nothing doubled when replayed again, History right | The 4.0 seed; between 02:00 and 22:00 IST |
| `v40-tenancy.live.mjs` | 147 | Two organisations: every cross-organisation call answers 404, the Super Admin's organisation switch, approval routing by department, manager view grants part by part over HTTP and on the live sockets, report runs, someone else's records, setup codes, the brief profile, per-organisation settings and calendar, sign-out keys | The 4.0 seed; it creates organisation B itself (safe to run again); `DATABASE_URL` on localhost (it writes three report runs) |
| `v40-integrity.live.mjs` | 124 | Offline evidence (a forged day counts nothing, a replayed day with its samples counts), the replay allowlist and 4.x User-Agent, a failed replay leaves an auto-closed day closed, the week pattern from a date and locked months, shift-name and organisation-delete races, and the second audit round (2-minute replayed sessions, backlog with today open, one late sample, End Day judged before it writes, no reopen past the latest end, replayed presence and away, SLA from receipt, End Day older than the open day, grant redactions, foreign departments, replays into a locked month) | The 4.0 seed; `DATABASE_URL` on localhost (it reads rows no API shows and locks and unlocks months itself) |
| `migrations-40.live.mjs` | 209 | No running API. The three 4.0 migrations on synthetic 3.1 data in two scenarios (one company, two companies), with the runbook's own queries read from `docs/4.0/DEPLOY.md`, idempotency and a boot of the built API; `VOLUME=n` times them on six months of data | A local PostgreSQL (`DATABASE_URL` on localhost) and `npx nest build`; it makes and drops its own scratch databases |
| `hardening.live.mjs` | 23 | Health, login lockout, password change and reset, socket checks, input validation | A freshly reset database and a freshly started API (the lockout lives in memory); `npm ci` in `web-portal` once (socket client); run it last |
| `perf-team-month.live.mjs` | 8 | Writes a month for 100 people of five departments (about 1.4 million samples) and times the team month report (last median about 1.1 s); `BUDGET_MS` (default 1500) | A freshly reset database and a running API; `DATABASE_URL` on localhost |
| `migrations.live.mjs` | | No API. The 3.0 to 3.1 migrations on a scratch copy (history; production is on 3.1) | A local database |

A Super Admin works inside one organisation in 4.0: the scripts send `X-Org-Id` (the seeded organisation, `SEED_ORG` in `lib.mjs`) where they act as one. `socket.mjs` is a small socket.io client over Node's WebSocket for `v40-tenancy` (no client package).

`legacy-3.1/` keeps the 3.1 suites (`v31`, `breaks`, `followups`, `simulate-month`) for reference. They test 3.1 rules (the Super Admin approval pool, managers by direct reports) that 4.0 replaced, so they are not run for 4.0.

## Run

Node 20 or later. In `backend/`:

```bash
# 1. Wipe the database, re-apply the migrations and seed the demo data
npx prisma migrate reset --force
#    (staging with NODE_ENV=production: SEED_DEMO_DATA=true npx prisma migrate reset --force)

# 2. Start the API (a second terminal), and wait for "RX Vision API on ..."
npm run start:dev

# 3. Run the 4.0 scripts, lead first
node test/live/v40-lead.live.mjs
node test/live/v40-offline.live.mjs
node test/live/v40-tenancy.live.mjs
node test/live/v40-integrity.live.mjs
```

Reset and restart before `hardening.live.mjs` and before `perf-team-month.live.mjs`. Each script ends with `N passed, 0 failed` and exits with a non-zero code if any check fails; if one fails after another has run, reset, restart and run it alone before reporting it.

`migrations-40.live.mjs` needs neither a reset nor the API: build first (`npx nest build`, its boot check starts `dist`), then `node test/live/migrations-40.live.mjs` (both scenarios), `SCENARIO=A` or `B` for one, `BOOT=0` without the boot check, `VOLUME=5` to time the migrations on six months of 200 people. `MIG40_PORT` (default 4700) is the port of the API it boots. `migrations.live.mjs` also works on its own scratch database next to the local one.

`hardening.live.mjs` takes its socket client from the portal, so run `npm ci` in `web-portal` once first.

## Settings

| Variable | Default | Note |
| --- | --- | --- |
| `API` | `http://localhost:4000/api/v1` | The API under test |
| `APP_TIMEZONE` | `Asia/Kolkata` | Must equal the API's: `v40-lead.live.mjs` builds a shift around the current time in that zone |
| `SEED_ORG` | the seeded organisation | The organisation a Super Admin acts in |
| `DATABASE_URL` | from `backend/.env` | `v40-tenancy`, `v40-integrity`, `migrations-40`, `migrations` and `perf-team-month` only; must point at `localhost` |
| `OLD_EMAIL`, `OLD_PASSWORD` | a Staff member `v40-lead` creates | `v40-lead.live.mjs`: the account its 3.1 agent part signs in as |
