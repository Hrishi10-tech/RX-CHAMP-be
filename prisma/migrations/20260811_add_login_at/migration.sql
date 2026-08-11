-- Add the PC login time to the per-day work-day row, and allow the row to exist
-- before the day is ended (so login can be recorded on its own). "Day ended" now
-- means ended_at IS NOT NULL rather than "a row exists".
ALTER TABLE "work_day_ends" ADD COLUMN "login_at" TIMESTAMP(3);
ALTER TABLE "work_day_ends" ALTER COLUMN "ended_at" DROP NOT NULL;
