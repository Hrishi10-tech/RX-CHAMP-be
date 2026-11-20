-- RX Vision 3.2, ported to 4.0: screenshot reports, monthly archives and monthly
-- deletion, per organisation (company_id). Additive only.

-- CreateEnum
CREATE TYPE "ScreenshotExportKind" AS ENUM ('PERSON_REPORT', 'MONTH_ARCHIVE', 'MONTH_PURGE');

-- CreateEnum
CREATE TYPE "ScreenshotExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "screenshot_exports" (
    "id" UUID NOT NULL,
    "kind" "ScreenshotExportKind" NOT NULL,
    "status" "ScreenshotExportStatus" NOT NULL DEFAULT 'QUEUED',
    "requested_by_id" UUID NOT NULL,
    "company_id" UUID,
    "user_id" UUID,
    "month" TEXT,
    "from_date" TEXT,
    "to_date" TEXT,
    "from_time" TEXT,
    "to_time" TEXT,
    "archive_id" UUID,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "storage_key" TEXT,
    "file_name" TEXT,
    "error" TEXT,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "covered_until" TIMESTAMP(3),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screenshot_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "screenshot_exports_kind_month_status_idx" ON "screenshot_exports"("kind", "month", "status");

-- CreateIndex
CREATE INDEX "screenshot_exports_status_created_at_idx" ON "screenshot_exports"("status", "created_at");

-- CreateIndex
CREATE INDEX "screenshot_exports_requested_by_id_created_at_idx" ON "screenshot_exports"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "screenshots_user_id_taken_at_idx" ON "screenshots"("user_id", "taken_at");

-- CreateIndex
CREATE INDEX "screenshot_exports_company_id_kind_month_status_idx" ON "screenshot_exports"("company_id", "kind", "month", "status");
