# Time Champ — Backend (production)

Real backend for Time Champ, built as a **modular monolith** with **Clean
Architecture / DDD** on **NestJS + Prisma + PostgreSQL**. It preserves
the `/api/v1` contract of the throwaway demo (`../server.js`), so the agent and
dashboard keep working — only the internals are now production-grade.

> This first cut ships the **foundation + one complete vertical slice**
> (`auth` + `users`) wired end-to-end through all four layers. The remaining
> modules (`tracking`, `reports`, `screenshots`, `attendance`, `chat`,
> `companies`, `shifts`, `permissions`, `notifications`, `dashboard`) follow the
> exact same pattern — see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stack

| Concern | Choice |
|---|---|
| Runtime / language | Node 20, TypeScript |
| Framework | NestJS (REST) |
| DB / ORM | PostgreSQL, Prisma (migrations) |
| Cache | In-memory (`CacheService` port; swappable) |
| Auth | JWT access + refresh (rotation), Passport, bcrypt, RBAC |
| Validation | class-validator / class-transformer |
| Docs | Swagger / OpenAPI at `/docs` |
| Logging | Pino (nestjs-pino) |
| Tests | Jest (unit) + Supertest (e2e) |
| Container | Docker + docker-compose (+ nginx) |

## Quick start (Docker — everything)

```bash
cd backend
cp .env.example .env          # then edit secrets
docker compose up --build     # postgres + backend + nginx
```

API: <http://localhost:4000/api/v1> · Swagger: <http://localhost:4000/docs> ·
through nginx: <http://localhost/api/v1>

## Quick start (local dev)

```bash
cd backend
cp .env.example .env
npm install
docker compose up -d postgres           # just the dependencies
npx prisma migrate dev --name init      # create schema
npm run db:seed                         # roles, perms, demo accounts
npm run start:dev
```

### Seeded logins (same as the demo)

| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN | `admin@timechamp.test` | `admin123` |
| MANAGER | `manager@timechamp.test` | `manager123` |
| USER | `user@timechamp.test` | `user123` |

## Endpoints in this slice

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness (+ DB ping) |
| GET | `/metrics` | basic process metrics |
| POST | `/api/v1/auth/login` | `{ token, refreshToken, user }` |
| POST | `/api/v1/auth/refresh` | rotate token pair |
| POST | `/api/v1/auth/logout` | revoke refresh token |
| GET | `/api/v1/auth/me` | current user (403 if disabled) |
| GET | `/api/v1/users` | role-scoped list (`meta.total`) |
| POST | `/api/v1/users` | bulk create → `{ created, errors, defaultPassword }` |
| POST | `/api/v1/users/:id/status` | enable/disable a team member |
| DELETE | `/api/v1/users/:id` | soft delete (history kept) |

Every success: `{ success: true, data, ...meta }`.
Every error: `{ success: false, error: { code, message } }`.

## Scripts

```bash
npm run start:dev     # watch mode
npm run build         # compile to dist/
npm test              # unit tests
npm run test:e2e      # e2e (needs postgres + seed)
npm run lint          # eslint --fix
npm run prisma:studio # browse the DB
```

## Tests

- **Unit** — entities, value objects, domain services, use cases (ports mocked,
  no DB). `npm test`
- **E2E** — full HTTP→DB chain asserting the envelopes. Needs a seeded DB.
  `npm run test:e2e`
