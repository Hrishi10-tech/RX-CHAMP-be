-- =============================================================================
-- RX Vision 4.0 (2 of 3): organisations, departments, break segments, away
-- events, calendar, sign-out keys and offline replay. Schema only (DDL).
--
-- Additive except the report_runs unique key, which moves to
-- (company_id, month, scope, owner_id) in 20261020_v40_3_backfill once every row
-- has a company. month_locks.company_id and report_runs.company_id start
-- nullable and become NOT NULL there. A 3.1 build keeps running on this schema
-- until the backfill migration runs.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- DropIndex
DROP INDEX "report_runs_month_scope_owner_id_key";

-- AlterTable
ALTER TABLE "break_records" ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "planned_min" INTEGER,
ADD COLUMN     "state" "BreakState" NOT NULL DEFAULT 'ENDED',
ADD COLUMN     "taken_sec" INTEGER;

-- AlterTable
ALTER TABLE "meeting_records" ADD COLUMN     "mom_sender" TEXT;

-- AlterTable
ALTER TABLE "month_locks" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "report_runs" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "department_id" UUID,
ADD COLUMN     "enroll_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "grant_activity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grant_screenshots" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grant_timeline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "idle_enabled" BOOLEAN,
ADD COLUMN     "idle_minutes" INTEGER;

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'briefcase',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_departments" (
    "manager_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_departments_pkey" PRIMARY KEY ("manager_id","department_id")
);

-- CreateTable
CREATE TABLE "break_segments" (
    "id" UUID NOT NULL,
    "break_record_id" UUID NOT NULL,
    "presence_session_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "away_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID,
    "date" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "seconds" INTEGER,
    "reason_key" TEXT,
    "reason_kind" TEXT,
    "reason_label" TEXT,
    "comment" TEXT,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "mom_sender" TEXT,
    "status" "AwayStatus" NOT NULL,
    "approver_role" "RoleName",
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "due_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "away_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_days" (
    "company_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "is_working" BOOLEAN NOT NULL,
    "label" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_days_pkey" PRIMARY KEY ("company_id","date")
);

-- CreateTable
CREATE TABLE "sign_out_keys" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "phrase_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "scope" "SignOutScope" NOT NULL,
    "user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "uses" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sign_out_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "user_id" UUID NOT NULL,
    "client_event_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "event_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" INTEGER NOT NULL,
    "body" JSONB NOT NULL,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("user_id","client_event_id")
);

-- CreateIndex
CREATE INDEX "departments_company_id_idx" ON "departments"("company_id");

-- CreateIndex
CREATE INDEX "manager_departments_department_id_idx" ON "manager_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "break_segments_presence_session_id_key" ON "break_segments"("presence_session_id");

-- CreateIndex
CREATE INDEX "break_segments_break_record_id_idx" ON "break_segments"("break_record_id");

-- CreateIndex
CREATE INDEX "away_events_user_id_date_idx" ON "away_events"("user_id", "date");

-- CreateIndex
CREATE INDEX "away_events_company_id_status_date_idx" ON "away_events"("company_id", "status", "date");

-- CreateIndex
CREATE INDEX "away_events_status_due_at_idx" ON "away_events"("status", "due_at");

-- CreateIndex
CREATE INDEX "sign_out_keys_company_id_expires_at_idx" ON "sign_out_keys"("company_id", "expires_at");

-- CreateIndex
CREATE INDEX "agent_events_received_at_idx" ON "agent_events"("received_at");

-- CreateIndex
CREATE INDEX "agent_events_user_id_event_at_idx" ON "agent_events"("user_id", "event_at");


-- CreateIndex
CREATE INDEX "users_company_id_idx" ON "users"("company_id");

-- CreateIndex
CREATE INDEX "users_department_id_idx" ON "users"("department_id");

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "month_locks" ADD CONSTRAINT "month_locks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_departments" ADD CONSTRAINT "manager_departments_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_departments" ADD CONSTRAINT "manager_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_segments" ADD CONSTRAINT "break_segments_break_record_id_fkey" FOREIGN KEY ("break_record_id") REFERENCES "break_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_segments" ADD CONSTRAINT "break_segments_presence_session_id_fkey" FOREIGN KEY ("presence_session_id") REFERENCES "presence_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "away_events" ADD CONSTRAINT "away_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign_out_keys" ADD CONSTRAINT "sign_out_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Department names are unique per organisation, ignoring case and spacing, while not deleted.
CREATE UNIQUE INDEX "departments_company_name_key" ON "departments"
  ("company_id", lower(regexp_replace(btrim("name"), '\s+', ' ', 'g'))) WHERE "deleted_at" IS NULL;

-- At most one open segment per break.
CREATE UNIQUE INDEX "break_segments_one_open_per_break" ON "break_segments" ("break_record_id") WHERE "ended_at" IS NULL;
