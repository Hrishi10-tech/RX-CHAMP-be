-- =============================================================================
-- Shift breaks + three-tier roles
--
--  1. Roles become Super Admin -> Manager -> Staff. Every ADMIN account is moved
--     to MANAGER, the ADMIN role row is removed and the enum is rebuilt without it.
--     The three role rows are inserted if missing, so a fresh database no longer
--     depends on the seed script for them.
--  2. Shifts gain break rules (ring timing, reason rules, work days, default flag)
--     and three new tables: shift_breaks, shift_assignments, break_records.
--  3. Each person's existing users.shift_id is carried over as an explicit USER
--     assignment, so nobody's shift changes when department shifts are set up.
--
-- Wrapped in one transaction: it either applies completely or not at all.
-- UUIDs are built from md5() so the script needs no extension on any Postgres.
-- =============================================================================
BEGIN;

-- ---- 1. Roles ----------------------------------------------------------------
INSERT INTO "roles" ("id", "name", "permissions", "created_at", "updated_at")
SELECT md5(random()::text || clock_timestamp()::text || r.name)::uuid, r.name::"RoleName", r.perms, now(), now()
FROM (VALUES
  ('SUPER_ADMIN', ARRAY['CREATE_USER','UPDATE_USER','DELETE_USER','VIEW_TEAM','VIEW_REPORT','MANAGE_COMPANY','MANAGE_SHIFT','ASSIGN_MEMBER','VIEW_SCREENSHOTS','SEND_CHAT']::text[]),
  ('MANAGER',     ARRAY['CREATE_USER','UPDATE_USER','DELETE_USER','VIEW_TEAM','VIEW_REPORT','ASSIGN_MEMBER','VIEW_SCREENSHOTS','SEND_CHAT']::text[]),
  ('USER',        ARRAY[]::text[])
) AS r(name, perms)
WHERE NOT EXISTS (SELECT 1 FROM "roles" x WHERE x."name"::text = r.name);

UPDATE "users"
SET "role_id" = (SELECT "id" FROM "roles" WHERE "name"::text = 'MANAGER'),
    "updated_at" = now()
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "name"::text = 'ADMIN');

DELETE FROM "roles" WHERE "name"::text = 'ADMIN';

CREATE TYPE "RoleName_new" AS ENUM ('SUPER_ADMIN', 'MANAGER', 'USER');
ALTER TABLE "roles" ALTER COLUMN "name" TYPE "RoleName_new" USING ("name"::text::"RoleName_new");
ALTER TYPE "RoleName" RENAME TO "RoleName_old";
ALTER TYPE "RoleName_new" RENAME TO "RoleName";
DROP TYPE "RoleName_old";

-- ---- 2. Shift break model ----------------------------------------------------
CREATE TYPE "BreakKind" AS ENUM ('MORNING', 'LUNCH', 'EVENING');
CREATE TYPE "BreakTiming" AS ENUM ('ON_TIME', 'EARLY', 'LATE', 'OUTSIDE_WINDOW', 'UNSCHEDULED');
CREATE TYPE "BreakApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "ShiftAssignmentTarget" AS ENUM ('DEPARTMENT', 'USER');

ALTER TABLE "shifts"
  ADD COLUMN "is_default"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overrun_grace_min" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "overrun_reason"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reason_min_chars"  INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "reason_on_early"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "reason_on_late"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "ring_duration_min" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "ring_lead_min"     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "ring_sound"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "work_days"         INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[];

CREATE TABLE "shift_breaks" (
    "id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "kind" "BreakKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "start_time" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "window_before_min" INTEGER NOT NULL DEFAULT 30,
    "window_after_min" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shift_breaks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "target" "ShiftAssignmentTarget" NOT NULL,
    "company_id" UUID,
    "department" TEXT,
    "department_key" TEXT,
    "user_id" UUID,
    "shift_id" UUID,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "break_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "kind" "BreakKind",
    "seq" INTEGER NOT NULL DEFAULT 0,
    "presence_type" "PresenceType" NOT NULL,
    "shift_id" UUID,
    "shift_name" TEXT,
    "scheduled_start" TIMESTAMP(3),
    "duration_min" INTEGER,
    "window_open" TIMESTAMP(3),
    "window_close" TIMESTAMP(3),
    "ring_start" TIMESTAMP(3),
    "ring_end" TIMESTAMP(3),
    "presence_session_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "timing" "BreakTiming" NOT NULL,
    "minutes_off" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "overrun_reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'AGENT',
    "approval_status" "BreakApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approver_role" "RoleName",
    "approver_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "break_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shift_breaks_shift_id_kind_key" ON "shift_breaks"("shift_id", "kind");
CREATE INDEX "shift_assignments_target_department_key_effective_from_idx" ON "shift_assignments"("target", "department_key", "effective_from");
CREATE INDEX "shift_assignments_user_id_effective_from_idx" ON "shift_assignments"("user_id", "effective_from");
CREATE INDEX "shift_assignments_shift_id_idx" ON "shift_assignments"("shift_id");
CREATE UNIQUE INDEX "break_records_presence_session_id_key" ON "break_records"("presence_session_id");
CREATE INDEX "break_records_user_id_date_idx" ON "break_records"("user_id", "date");
CREATE INDEX "break_records_approver_id_approval_status_date_idx" ON "break_records"("approver_id", "approval_status", "date");
CREATE INDEX "break_records_approver_role_approval_status_date_idx" ON "break_records"("approver_role", "approval_status", "date");
CREATE INDEX "break_records_approval_status_date_idx" ON "break_records"("approval_status", "date");
CREATE UNIQUE INDEX "break_records_user_id_date_kind_seq_key" ON "break_records"("user_id", "date", "kind", "seq");

ALTER TABLE "shift_breaks" ADD CONSTRAINT "shift_breaks_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "break_records" ADD CONSTRAINT "break_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "break_records" ADD CONSTRAINT "break_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "break_records" ADD CONSTRAINT "break_records_presence_session_id_fkey" FOREIGN KEY ("presence_session_id") REFERENCES "presence_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---- 3. Carry existing per-person shifts over as explicit assignments ---------
INSERT INTO "shift_assignments" ("id", "target", "company_id", "user_id", "shift_id", "effective_from", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || u."id"::text)::uuid, 'USER', u."company_id", u."id", u."shift_id", '2000-01-01', now()
FROM "users" u
JOIN "shifts" s ON s."id" = u."shift_id" AND s."deleted_at" IS NULL
WHERE u."shift_id" IS NOT NULL AND u."deleted_at" IS NULL;

COMMIT;
