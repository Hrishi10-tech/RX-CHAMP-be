-- RX Vision 3.5 calendars, ported onto 4.0's organisation calendar.
-- A day set on the calendar can be for some departments only (a department holiday);
-- departments and people can have their own week with a Saturday rule. Additive.
SET LOCAL lock_timeout = '15s';

ALTER TABLE "calendar_days" ADD COLUMN "department_ids" UUID[] DEFAULT ARRAY[]::UUID[];

CREATE TABLE "work_calendars" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "department_id" UUID,
    "user_id" UUID,
    "work_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "saturdays" TEXT NOT NULL DEFAULT 'EVERY',
    "saturday_anchor" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_calendars_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_calendars_department_id_key" ON "work_calendars"("department_id");
CREATE UNIQUE INDEX "work_calendars_user_id_key" ON "work_calendars"("user_id");
CREATE INDEX "work_calendars_company_id_idx" ON "work_calendars"("company_id");
