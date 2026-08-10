# Architecture

Clean Architecture + DDD inside a **modular monolith**. Dependencies point
inward only: **presentation → application → domain**, with **infrastructure**
implementing ports the inner layers declare. The domain knows nothing about
NestJS, Prisma, or HTTP.

```
            ┌─────────────── presentation ───────────────┐
            │  controllers, DTOs(IO), guards, Swagger     │
            └───────────────┬─────────────────────────────┘
                            │ calls
            ┌───────────────▼──────── application ─────────┐
            │  use cases, app services, mappers, DTOs      │
            │  PORTS: UserRepository, CacheService,        │
            │         TokenService, EventBus, ...          │
            └───────────────┬─────────────────────────────┘
                            │ depends on (interfaces only)
            ┌───────────────▼──────────── domain ──────────┐
            │  entities, value objects, domain services,    │
            │  domain events, domain exceptions             │
            └───────────────────────────────────────────────┘
                            ▲ implements ports
            ┌───────────────┴────────── infrastructure ────┐
            │  Prisma repositories, JWT service, cache,      │
            │  Passport strategy, persistence mappers        │
            └────────────────────────────────────────────────┘
```

## Folder layout

```
src/
  shared/                         # cross-cutting, used by every module
    config/    database/  cache/  security/  events/
    http/      logger/    rbac/   exceptions/  utils/
    types/     websocket/
  modules/
    auth/
      domain/         # refresh-token repo port
      application/    # login/refresh/logout use cases, token port + service,
                      # auth.types.ts, DTOs
      infrastructure/ # JWT service, passport strategy, prisma refresh repo, RBAC reader
      presentation/   # auth.controller
      auth.module.ts
    users/
      domain/         # User entity, Email/UserId VOs, UserAccessService,
                      # UserCreated event, UserRepository + ShiftReader ports
      application/    # create/list/status/delete/update/get-profile use cases,
                      # user.types.ts, DTOs, mappers
      infrastructure/ # PostgresUserRepository, PrismaShiftReader, persistence mapper
      presentation/   # users.controller
      users.module.ts
    activity/ analytics/ chat/ companies/ notifications/
    presence/ roles/ screenshots/
    agent/          # application/ (types + constants), presentation/
    health/         # application/ (types), presentation/
```

## Where types live

One rule per kind of type — no inline `interface` blocks in controllers, use
cases, mappers or gateways.

| Kind | Home | Examples |
| --- | --- | --- |
| Used by 2+ modules | `shared/types/*.types.ts` | `TeamMemberRef`, `UsageEntry`, `HourBucket`, `TimeInterval`, `UserStatus`, `PaginatedResult` |
| Port contract + its records/filters | `<module>/domain/<thing>.repository.ts` \| `.port.ts` | `ActivitySampleRecord`, `ListUsersFilter` |
| Read models + use-case results | `<module>/application/<module>.types.ts` | `PublicUser`, `TodayPresenceView`, `ListUsersResult` |
| Validated HTTP input | `<module>/application/dto/*.dto.ts` (+ `index.ts`) | `CreateUserDto`, `StartPresenceDto` |
| Tuning constants | `<module>/application/<module>.constants.ts` | `MAX_GAP_SEC`, `DEFAULT_WORKING_BASIS_SEC` |
| Persistence row/write shapes | `<module>/infrastructure/**/*.types.ts` | `PrismaUserWithRelations`, `UserWriteModel` |

Reuse before you declare: a new shape that a second module also needs moves to
`shared/types`. Repository filters extend `PageFilter`/`SearchPageFilter`;
list results are `PaginatedResult<'users', UserListItem>`; any port that needs
"who does this user report to?" extends `ManagerLookupReader` rather than
re-declaring `findManagerId`.

Gateways extend `shared/websocket/AuthenticatedGateway` for handshake auth and
use `userRoom()` / `managerRoom()` for room names, so every namespace
authenticates and addresses clients identically.

## The key rules (enforced by structure + review)

- **No business logic in controllers.** Controllers parse input and call one use
  case. See `users.controller.ts`.
- **No DB calls in use cases.** Use cases depend on repository *ports*
  (`USER_REPOSITORY`, `REFRESH_TOKEN_REPOSITORY`, ...). Prisma lives only in
  `infrastructure/`.
- **Dependency inversion everywhere.** Every external concern is a port
  (interface + Symbol token) bound to an implementation in the module's
  `providers`. Swap the cache backend, the ORM, or the JWT lib without touching use cases.
- **Domain is pure.** No `@nestjs/*`, no `@prisma/client`, no `express` imports
  under any `domain/` folder.

## Request lifecycle (e.g. `POST /api/v1/users`)

1. `ValidationPipe` validates/sanitizes the DTO (`whitelist: true`).
2. `JwtAuthGuard` → passport `jwt` strategy → `AuthUserReader` builds
   `AuthenticatedUser` (id, role, permissions) onto `req.user`.
3. `UsersController.create` calls `CreateUsersUseCase`.
4. The use case applies policy via `UserAccessService` (domain), hashes the
   default password (`PASSWORD_HASHER` port), writes through `USER_REPOSITORY`,
   and publishes `UserCreatedEvent` on the `EVENT_BUS`.
5. `ResponseInterceptor` wraps the return value → `{ success: true, data }`.
6. Any thrown `AppException`/`DomainException` → `AllExceptionsFilter` →
   `{ success: false, error: { code, message } }`.

## RBAC

- Roles: `SUPER_ADMIN > ADMIN > MANAGER > USER` (`shared/rbac/roles.enum.ts`).
- Fine-grained permissions live in the DB (`Role`→`RolePermission`→`Permission`)
  and are loaded into `AuthenticatedUser.permissions`.
- Guard with `@Roles(...)` / `@RequirePermissions(...)` + `RolesGuard` on a
  controller (after `JwtAuthGuard`). The `users` slice keeps the demo's exact
  per-action error codes inside the use cases instead, so the wire contract is
  identical.

## Event-driven / microservice readiness

- Modules talk to each other only through **ports** and **domain events**
  (`EVENT_BUS`). Today the bus is in-process (`InMemoryEventBus`); swap the
  binding for RabbitMQ/Kafka and a module can be extracted into its own service
  with no change to publishers/subscribers.
- Each module is a folder with its own 4 layers → lift-and-shift to
  `auth-service`, `user-service`, etc.

## Adding the next module (the recipe)

To add, say, `tracking` (the demo's `/tracking/*`):

1. `domain/` — `Device` entity, value objects, `DeviceRepository` port, domain
   events (`SnapshotReceived`).
2. `application/` — `SubmitSnapshotUseCase`, `GetLiveUseCase`, DTOs, mappers.
3. `infrastructure/` — `PostgresDeviceRepository` (implements the port) +
   persistence mapper. The Prisma models already exist in `schema.prisma`.
4. `presentation/` — `tracking.controller.ts` returning the demo payloads.
5. `tracking.module.ts` — bind ports, register use cases, add to `AppModule`.

Copy the shape of `users/` exactly; the envelopes, error codes and pagination
helpers (`shared/utils/pagination.ts`) are already provided.

## Performance & scale (500 → thousands of users)

- **Stateless app** → run N replicas behind nginx; scale horizontally.
- **Cache** (`CacheService` port) for hot reads (profiles, dashboards,
  reports). Cache keys are busted on writes (see `SetUserStatusUseCase`). The
  default binding is in-memory (process-local); for multi-replica deployments,
  bind the port to a shared cache (e.g. Redis) — no use-case changes needed.
- **Background jobs** (email, notifications, report/export generation) can be
  added behind a port the same way to keep request latency low.
- **Indexes + pagination** on every list (`schema.prisma` `@@index`,
  `parsePagination`).
- **Soft delete** keeps history without bloating hot queries (all reads filter
  `deletedAt: null`).

## Publishing the Windows agent

`GET /api/v1/agent/download` serves the compiled Windows agent. The binary is
**never** committed to the repo or baked into the Docker image — the runner stage
only copies `dist`, `prisma`, `node_modules` and `package*.json`. It is served
from S3 instead:

- `AgentController` → `AGENT_BINARY_STORE`. `agent.module.ts` binds
  `S3AgentBinaryStore` when `AGENT_S3_KEY` is set (production), else the local-disk
  store (developer machines).
- `S3AgentBinaryStore.info()` does a `HeadObject` on that key; a missing object is
  why the endpoint 404s with "Agent binary is not available on the server yet."

So a deploy only works once the binary has been built and uploaded. That is one
command:

```
npm run publish:agent        # build WinUI agent → zip → build installer exe → upload to S3
npm run build:agent          # same, but build only (no upload) for local checks
```

It uploads to two keys: a versioned one (`agent/<version>/RXChampAgent.exe`, for
rollback) and the stable `agent/RXChampAgent.exe`. Point the backend at one:

```
AGENT_S3_KEY=agent/RXChampAgent.exe          # always the latest published
AGENT_S3_KEY=agent/2.0.0/RXChampAgent.exe    # pin a specific version
```

Requirements to run it: Windows with the .NET 8 SDK (WinUI publish is Windows-only)
and AWS credentials the CLI can see (ambient `aws configure` / CI secrets / instance
role; for local dev it falls back to `AWS_*` in `.env`). See
`scripts/publish-agent.ps1`.

**CI:** `.github/` is not tracked in this repo (CI is managed in the parent
monorepo). To automate this on release, add a Windows job to that CI that runs
`npm run publish:agent` with AWS credentials in secrets — a ready-to-adapt
workflow is in `scripts/agent-release.workflow.yml`.
