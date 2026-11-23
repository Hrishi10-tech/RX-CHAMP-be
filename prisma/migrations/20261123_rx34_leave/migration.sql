-- =============================================================================
-- RX Vision 3.4: leave.
--
-- Two pools per person per year (CL/SL lapses, EL/PL carries over), counted in
-- quarter days; requests with their charged days; per-person yearly quotas; manual
-- adjustments. Additive: four new enums and five new tables, nothing existing
-- changes. Safe while the 3.3 API runs; deploy the 3.4 API right after.
-- The leave policy lives in app_settings (key 'leave') and is written by the API
-- the first time it is read, which also records the day leave went live.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "LeaveCategory" AS ENUM ('CLSL', 'ELPL');

-- CreateEnum
CREATE TYPE "LeaveKind" AS ENUM ('FULL_DAY', 'HALF_DAY', 'QUARTER_DAY');

-- CreateEnum
CREATE TYPE "LeavePart" AS ENUM ('FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED');

-- CreateTable
CREATE TABLE "leave_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "category" "LeaveCategory" NOT NULL,
    "granted_units" INTEGER NOT NULL,
    "grant_source" TEXT NOT NULL DEFAULT 'DEFAULT',
    "prorated" BOOLEAN NOT NULL DEFAULT false,
    "carry_cap_units" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_quotas" (
    "user_id" UUID NOT NULL,
    "category" "LeaveCategory" NOT NULL,
    "units_per_year" INTEGER NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_quotas_pkey" PRIMARY KEY ("user_id","category")
);

-- CreateTable
CREATE TABLE "leave_adjustments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "category" "LeaveCategory" NOT NULL,
    "delta_units" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "target_units" INTEGER,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "LeaveCategory" NOT NULL,
    "kind" "LeaveKind" NOT NULL,
    "part" "LeavePart",
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
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

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request_days" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "mask" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,

    CONSTRAINT "leave_request_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_accounts_year_idx" ON "leave_accounts"("year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_accounts_user_id_year_category_key" ON "leave_accounts"("user_id", "year", "category");

-- CreateIndex
CREATE INDEX "leave_adjustments_user_id_year_idx" ON "leave_adjustments"("user_id", "year");

-- CreateIndex
CREATE INDEX "leave_adjustments_created_at_idx" ON "leave_adjustments"("created_at");

-- CreateIndex
CREATE INDEX "leave_requests_user_id_status_idx" ON "leave_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "leave_requests_status_approver_role_idx" ON "leave_requests"("status", "approver_role");

-- CreateIndex
CREATE INDEX "leave_requests_start_date_idx" ON "leave_requests"("start_date");

-- CreateIndex
CREATE INDEX "leave_requests_year_category_idx" ON "leave_requests"("year", "category");

-- CreateIndex
CREATE INDEX "leave_request_days_user_id_date_idx" ON "leave_request_days"("user_id", "date");

-- CreateIndex
CREATE INDEX "leave_request_days_date_idx" ON "leave_request_days"("date");

-- CreateIndex
CREATE INDEX "leave_request_days_request_id_idx" ON "leave_request_days"("request_id");

-- AddForeignKey
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

