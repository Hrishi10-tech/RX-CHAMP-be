# RX Vision backend

The API behind the RX Vision portal and desktop agents: NestJS, Prisma 5.22 and PostgreSQL. Production runs it as one PM2 process behind nginx. Version 3.1.0 (tag `v3.1.0`).

Start with the 3.1 documentation set in [`../docs/3.1/`](../docs/3.1/README.md):

| Need | Read |
|---|---|
| Deploy to production | [`docs/3.1/DEPLOY.md`](../docs/3.1/DEPLOY.md) |
| Tests and counts | [`docs/3.1/TESTING.md`](../docs/3.1/TESTING.md) |
| Run it day to day | [`docs/3.1/OPERATIONS.md`](../docs/3.1/OPERATIONS.md) |
| How it fits together | [`docs/3.1/ARCHITECTURE.md`](../docs/3.1/ARCHITECTURE.md) |
| The API contract | [`docs/api-3.1.md`](docs/api-3.1.md) |
| Set up a server from scratch (Lightsail, PM2, nginx, TLS) | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Every setting the app reads | [`.env.example`](.env.example) |

## Modules

`src/modules`: activity, agent, analytics, auth, chat, companies, health, notifications, presence, reports, roles, screenshots, settings, shifts, users, worktime. Shared code (database, events, security, time zone helpers) lives in `src/shared`. Migrations are in `prisma/migrations` (7, from `0_init` to `20261014_focus_meetings_reports_backfill`).

## Run locally

You need Node 20 and PostgreSQL 12 or later on `localhost`. The live checks refuse any other host. The database user must be able to create databases: `test/live/migrations.live.mjs` builds a scratch database beside yours.

1. Start a local database. With Docker:

   ```bash
   docker run -d --name rxv-postgres -p 127.0.0.1:5432:5432 \
     -e POSTGRES_USER=rxv -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=rxv postgres:16-alpine
   ```

   Any other local PostgreSQL 12+ works the same way. Do not use `docker compose` for this: its `postgres` service sits behind the `local-db` profile and is not published to your machine.
2. Install and configure:

   ```bash
   cd backend
   npm ci
   cp .env.example .env
   ```

   In `.env`, set `DATABASE_URL=postgresql://rxv:<password>@localhost:5432/rxv?schema=public` and keep `NODE_ENV=development`.
3. Create the schema and the demo data:

   ```bash
   npx prisma migrate reset --force
   ```

   It drops everything in that database, applies the 7 migrations and seeds the demo accounts. Never point it at a database you need. Do not use `prisma migrate dev`: it would write a new migration. Releases apply the existing ones with `prisma migrate deploy` (production) or `migrate reset` (local).
4. Start the API:

   ```bash
   npm run start:dev
   ```

   Wait for `RX Vision API on http://localhost:4000/api/v1  (docs: /docs)`. The API docs are at `http://localhost:4000/docs` (off in production unless `SWAGGER_ENABLED=true`).

Demo accounts, for local use only. The seed creates them only outside production, and never in a database that already has real accounts:

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@timechamp.test` | `admin123` |
| Manager | `manager@timechamp.test` | `manager123` |
| Staff | `user@timechamp.test` | `user123` |

To run the portal against this API, see [`../web-portal/README.md`](../web-portal/README.md).

## Tests

| Suite | Command | Count on 14 Oct | Needs |
|---|---|---|---|
| Unit | `npx jest` | 62 suites, 594 tests | Nothing |
| End-to-end | `npx prisma migrate reset --force`, then `npm run test:e2e` | 9 tests | A database you can wipe |
| Live API checks | `node test/live/<script>.live.mjs` | 7 scripts, 686 checks | A freshly reset local database and a running API: [`test/live/README.md`](test/live/README.md) |

Never run the end-to-end or live suites against production: they wipe or change data. Details and the agent and portal suites: [`docs/3.1/TESTING.md`](../docs/3.1/TESTING.md) section (a).

## Scripts

```bash
npm run start:dev      # watch mode
npm run build          # compile to dist/
npm run start:prod     # node dist/main.js
npx jest               # unit tests
npm run test:e2e       # end-to-end tests (a migrated, seeded database)
npm run lint           # eslint --fix
npm run prisma:studio  # browse the local database
```
