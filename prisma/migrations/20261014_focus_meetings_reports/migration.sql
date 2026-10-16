-- =============================================================================
-- RX Vision 3.1: work sessions, focus time, meetings, approvals SLA, reports
--
-- Schema only (DDL), additive: new enums, tables, columns and indexes. Nothing is
-- dropped or rewritten, so a 3.0 build still runs on it (code-only rollback).
-- The data backfills are the next migration, 20261014_focus_meetings_reports_backfill.
--
--  1. Enums: BreakOutcome, MeetingMode, WorkSessionEndReason.
--  2. break_records gains outcome (skips), overrun_sec, overrun_asked,
--     commented_at and the 48-hour columns (due_at, escalated_at, reminded_at).
--     shift_breaks gains allow_skip; shifts.overrun_grace_min defaults to 3
--     (existing rows keep their value).
--  3. New tables: work_sessions, meeting_records, app_settings, report_runs,
--     month_locks. One open work session per person is also enforced by the
--     partial unique index work_sessions_one_open_per_user (Prisma cannot model it).
--
-- Prisma sends the file as one batch, which PostgreSQL runs as one implicit
-- transaction: it applies completely or not at all. Stop the API first; the lock
-- timeout makes a busy table fail the migration in 15 s instead of queueing
-- every other query behind it. Timestamps are timestamp(3) holding UTC, like
-- every Prisma DateTime column. PostgreSQL 12 or later.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- ---- 1. Enums ----------------------------------------------------------------
CREATE TYPE "BreakOutcome" AS ENUM ('TAKEN', 'SKIPPED', 'AUTO_SKIPPED');
CREATE TYPE "MeetingMode" AS ENUM ('LIVE', 'PAST');
CREATE TYPE "WorkSessionEndReason" AS ENUM ('USER', 'AUTO_CLOSED');

-- ---- 2. Existing tables ------------------------------------------------------
ALTER TABLE "break_records"
  ADD COLUMN "commented_at"  TIMESTAMP(3),
  ADD COLUMN "due_at"        TIMESTAMP(3),
  ADD COLUMN "escalated_at"  TIMESTAMP(3),
  ADD COLUMN "outcome"       "BreakOutcome" NOT NULL DEFAULT 'TAKEN',
  ADD COLUMN "overrun_asked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overrun_sec"   INTEGER,
  ADD COLUMN "reminded_at"   TIMESTAMP(3);

ALTER TABLE "shift_breaks" ADD COLUMN "allow_skip" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "shifts" ALTER COLUMN "overrun_grace_min" SET DEFAULT 3;

-- ---- 3. New tables -----------------------------------------------------------
CREATE TABLE "work_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" "WorkSessionEndReason",
    "source" TEXT NOT NULL DEFAULT 'AGENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "mode" "MeetingMode" NOT NULL,
    "agenda" TEXT NOT NULL,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "presence_session_id" UUID,
    "approval_status" "BreakApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approver_role" "RoleName",
    "approver_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "due_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "report_runs" (
    "id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB NOT NULL,
    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "month_locks" (
    "month" TEXT NOT NULL,
    "locked_by_id" UUID NOT NULL,
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    CONSTRAINT "month_locks_pkey" PRIMARY KEY ("month")
);

-- ---- Indexes -----------------------------------------------------------------
CREATE INDEX "work_sessions_user_id_date_idx" ON "work_sessions"("user_id", "date");
CREATE INDEX "work_sessions_ended_at_idx" ON "work_sessions"("ended_at");
-- At most one open session per person (the safety net behind the user row lock).
CREATE UNIQUE INDEX "work_sessions_one_open_per_user" ON "work_sessions"("user_id") WHERE "ended_at" IS NULL;

CREATE UNIQUE INDEX "meeting_records_presence_session_id_key" ON "meeting_records"("presence_session_id");
CREATE INDEX "meeting_records_user_id_date_idx" ON "meeting_records"("user_id", "date");
CREATE INDEX "meeting_records_approver_id_approval_status_date_idx" ON "meeting_records"("approver_id", "approval_status", "date");
CREATE INDEX "meeting_records_approver_role_approval_status_date_idx" ON "meeting_records"("approver_role", "approval_status", "date");
CREATE INDEX "meeting_records_approval_status_due_at_idx" ON "meeting_records"("approval_status", "due_at");

CREATE INDEX "report_runs_owner_id_month_idx" ON "report_runs"("owner_id", "month");
CREATE UNIQUE INDEX "report_runs_month_scope_owner_id_key" ON "report_runs"("month", "scope", "owner_id");

CREATE INDEX "break_records_approval_status_due_at_idx" ON "break_records"("approval_status", "due_at");

-- ---- Foreign keys --------------------------------------------------------------
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_presence_session_id_fkey" FOREIGN KEY ("presence_session_id") REFERENCES "presence_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
