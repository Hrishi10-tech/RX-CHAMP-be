-- =============================================================================
-- RX Vision 3.5 on 4.0: biometric attendance, work from home, comp off. (3.5's
-- calendars are in 20261123_rx35_calendars, on 4.0's organisation calendar.)
--
-- 4.0: punches and device keys belong to an organisation, and a biometric code is
-- unique within an organisation, not across all of them.
--
-- Additive: new tables and columns, nothing existing changes meaning. Every person
-- stays on the desktop agent (users.attendance_source defaults to AGENT). The
-- "LeaveCategory" enum gains COMPOFF as a new type (the columns cast over, the old
-- type dropped), so it works on any PostgreSQL version inside the migration's
-- transaction. Safe while the previous API runs; deploy the new API right after.
-- Settings (each organisation's 'biometric', 'wfh' and the comp off fields of its
-- leave policy) are written by the API when first changed; until then the
-- defaults apply.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- ---- Leave: comp off is a third leave type -------------------------------------
CREATE TYPE "LeaveCategory_new" AS ENUM ('CLSL', 'ELPL', 'COMPOFF');
ALTER TABLE "leave_accounts" ALTER COLUMN "category" TYPE "LeaveCategory_new" USING ("category"::text::"LeaveCategory_new");
ALTER TABLE "leave_quotas" ALTER COLUMN "category" TYPE "LeaveCategory_new" USING ("category"::text::"LeaveCategory_new");
ALTER TABLE "leave_adjustments" ALTER COLUMN "category" TYPE "LeaveCategory_new" USING ("category"::text::"LeaveCategory_new");
ALTER TABLE "leave_requests" ALTER COLUMN "category" TYPE "LeaveCategory_new" USING ("category"::text::"LeaveCategory_new");
ALTER TYPE "LeaveCategory" RENAME TO "LeaveCategory_old";
ALTER TYPE "LeaveCategory_new" RENAME TO "LeaveCategory";
DROP TYPE "LeaveCategory_old";

-- ---- Attendance source (3.5) ----------------------------------------------------
ALTER TABLE "users" ADD COLUMN "attendance_source" TEXT NOT NULL DEFAULT 'AGENT',
ADD COLUMN "attendance_source_from" TEXT,
ADD COLUMN "biometric_code" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_attendance_source_check" CHECK ("attendance_source" IN ('AGENT', 'BIOMETRIC'));

-- CreateTable
CREATE TABLE "biometric_punches" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "code_key" TEXT NOT NULL,
    "punched_at" TIMESTAMP(3) NOT NULL,
    "direction" TEXT,
    "device_id" TEXT NOT NULL DEFAULT '',
    "external_id" TEXT,
    "source" TEXT NOT NULL,
    "user_id" UUID,
    "day_key" TEXT NOT NULL,
    "note" TEXT,
    "created_by_id" UUID,
    "key_id" UUID,
    "locked_out" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_keys" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,

    CONSTRAINT "biometric_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wfh_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "LeaveKind" NOT NULL,
    "part" "LeavePart",
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approver_role" "RoleName",
    "approver_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wfh_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wfh_request_days" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "mask" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,

    CONSTRAINT "wfh_request_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wfh_schedules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "weekdays" INTEGER[],
    "weeks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "kind" "LeaveKind" NOT NULL,
    "part" "LeavePart",
    "from_date" TEXT NOT NULL,
    "to_date" TEXT,
    "skip_dates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wfh_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comp_off_credits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "worked_date" TEXT NOT NULL,
    "day_kind" TEXT NOT NULL,
    "day_label" TEXT NOT NULL DEFAULT '',
    "worked_sec" INTEGER NOT NULL DEFAULT 0,
    "asked_units" INTEGER NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CLAIM',
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "approver_role" "RoleName",
    "approver_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "expires_on" TEXT,
    "expiry_notice_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comp_off_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "biometric_punches_user_id_day_key_idx" ON "biometric_punches"("user_id", "day_key");

-- CreateIndex
CREATE INDEX "biometric_punches_code_key_punched_at_idx" ON "biometric_punches"("code_key", "punched_at");

-- CreateIndex
CREATE INDEX "biometric_punches_punched_at_idx" ON "biometric_punches"("punched_at");

-- CreateIndex
CREATE INDEX "biometric_punches_received_at_idx" ON "biometric_punches"("received_at");

-- CreateIndex
CREATE INDEX "biometric_punches_device_id_punched_at_idx" ON "biometric_punches"("device_id", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_punches_company_id_code_key_punched_at_device_id_key" ON "biometric_punches"("company_id", "code_key", "punched_at", "device_id");

-- CreateIndex
CREATE INDEX "biometric_punches_company_id_code_key_punched_at_idx" ON "biometric_punches"("company_id", "code_key", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_keys_hash_key" ON "biometric_keys"("hash");

-- CreateIndex
CREATE INDEX "biometric_keys_company_id_idx" ON "biometric_keys"("company_id");

-- CreateIndex
CREATE INDEX "wfh_requests_user_id_status_idx" ON "wfh_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "wfh_requests_status_approver_role_idx" ON "wfh_requests"("status", "approver_role");

-- CreateIndex
CREATE INDEX "wfh_requests_start_date_idx" ON "wfh_requests"("start_date");

-- CreateIndex
CREATE INDEX "wfh_request_days_user_id_date_idx" ON "wfh_request_days"("user_id", "date");

-- CreateIndex
CREATE INDEX "wfh_request_days_date_idx" ON "wfh_request_days"("date");

-- CreateIndex
CREATE INDEX "wfh_request_days_request_id_idx" ON "wfh_request_days"("request_id");

-- CreateIndex
CREATE INDEX "wfh_schedules_user_id_idx" ON "wfh_schedules"("user_id");

-- CreateIndex
CREATE INDEX "wfh_schedules_from_date_idx" ON "wfh_schedules"("from_date");

-- CreateIndex
CREATE INDEX "comp_off_credits_user_id_status_idx" ON "comp_off_credits"("user_id", "status");

-- CreateIndex
CREATE INDEX "comp_off_credits_status_approver_role_idx" ON "comp_off_credits"("status", "approver_role");

-- CreateIndex
CREATE INDEX "comp_off_credits_worked_date_idx" ON "comp_off_credits"("worked_date");

-- CreateIndex
CREATE INDEX "comp_off_credits_expires_on_idx" ON "comp_off_credits"("expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_biometric_code_key" ON "users"("company_id", "biometric_code");

-- AddForeignKey
ALTER TABLE "wfh_request_days" ADD CONSTRAINT "wfh_request_days_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "wfh_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One claim or credit per person per day worked, while it is waiting or approved.
CREATE UNIQUE INDEX "comp_off_credits_one_active_per_day" ON "comp_off_credits"("user_id", "worked_date") WHERE "status" IN ('PENDING', 'APPROVED');

-- Punch directions are IN, OUT or unknown (null); sources are fixed.
ALTER TABLE "biometric_punches" ADD CONSTRAINT "biometric_punches_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('IN', 'OUT'));
ALTER TABLE "biometric_punches" ADD CONSTRAINT "biometric_punches_source_check" CHECK ("source" IN ('PUSH', 'PULL', 'CSV', 'MANUAL'));
