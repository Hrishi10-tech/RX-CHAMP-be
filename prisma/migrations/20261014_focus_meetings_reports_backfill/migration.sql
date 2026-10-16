-- =============================================================================
-- RX Vision 3.1: data backfill (the schema is 20261014_focus_meetings_reports)
--
--  1. Lunch is not skippable by default (rest rule); a Super Admin can still
--     allow it per shift. Shifts still on the 3.0 overrun grace of 2 minutes get
--     the 3.1 default of 3. Rows changed after the schema migration ran (a Super
--     Admin's choice on a database that ran an earlier version of this backfill)
--     are left alone.
--  2. Items already waiting for a decision get the 48-hour clock from now (or
--     from when they were created, if later), so nobody is overdue on day one.
--  3. 3.0 overruns sent for a decision with a reason count as asked (the plus
--     part of focus time), with overrun_sec from the break's presence session.
--  4. Every past day of 3.0 / 2.x attendance becomes one closed work session
--     (source BACKFILL), so reports show history from the first day: from the PC
--     login to End Day, or to the last keyboard or mouse input when End Day was
--     never pressed (AUTO_CLOSED), and never longer than 14 hours. Today is left
--     alone: the server opens today's sessions itself. Rows with no usable end
--     are skipped, and so is any (user, day) that already has a work session
--     (a rerun, or a database that ran an earlier version), so a day is never
--     counted twice. Ids are md5 of (user, date) shaped as v4 UUIDs: no extension
--     is needed.
--
-- One implicit transaction, like the schema migration: all or nothing. The last
-- inputs are read in one pass over activity_samples (one GROUP BY), not per row.
-- "Today" is the business day in Asia/Kolkata (the APP_TIMEZONE default); edit
-- the two literals below before deploying with another APP_TIMEZONE.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- ---- 1. Lunch and the overrun grace ----------------------------------------------
-- When the schema migration finished (now, if it cannot be found).
CREATE TEMP TABLE "rxv_schema_applied" ON COMMIT DROP AS
SELECT COALESCE(
         (SELECT max("finished_at") AT TIME ZONE 'UTC'
            FROM "_prisma_migrations"
           WHERE "migration_name" = '20261014_focus_meetings_reports'
             AND "rolled_back_at" IS NULL),
         now() AT TIME ZONE 'UTC') AS "at";

UPDATE "shift_breaks" SET "allow_skip" = false
WHERE "kind" = 'LUNCH' AND "allow_skip"
  AND "updated_at" <= (SELECT "at" FROM "rxv_schema_applied");

UPDATE "shifts" SET "overrun_grace_min" = 3
WHERE "overrun_grace_min" = 2
  AND "updated_at" <= (SELECT "at" FROM "rxv_schema_applied");

-- ---- 2. The 48-hour clock --------------------------------------------------------
UPDATE "break_records"
SET "due_at" = GREATEST("created_at", now() AT TIME ZONE 'UTC') + interval '48 hours'
WHERE "approval_status" = 'PENDING' AND "due_at" IS NULL;

-- ---- 3. Overruns that asked for a decision ---------------------------------------
UPDATE "break_records" b
SET "overrun_asked" = true,
    "overrun_sec" = (
      SELECT GREATEST(0, round(extract(epoch FROM (p."ended_at" - b."started_at")))::int
                         - b."duration_min" * 60)
        FROM "presence_sessions" p
       WHERE p."id" = b."presence_session_id"
         AND p."ended_at" IS NOT NULL)
WHERE b."outcome" = 'TAKEN'
  AND b."overrun_reason" IS NOT NULL
  AND b."approval_status" <> 'NOT_REQUIRED'
  AND b."overrun_asked" = false;

-- ---- 4. Past days become work sessions -------------------------------------------
INSERT INTO "work_sessions" ("id", "user_id", "date", "started_at", "ended_at", "end_reason", "source", "created_at", "updated_at")
SELECT overlay(overlay(md5('work_session:' || d."user_id"::text || ':' || d."date")
                       placing '4' from 13) placing '8' from 17)::uuid,
       d."user_id",
       d."date",
       d."login_at",
       LEAST(d."end_at", d."login_at" + interval '14 hours'),
       CASE WHEN d."ended_at" IS NOT NULL AND d."ended_at" <= d."login_at" + interval '14 hours'
            THEN 'USER'::"WorkSessionEndReason"
            ELSE 'AUTO_CLOSED'::"WorkSessionEndReason" END,
       'BACKFILL',
       now() AT TIME ZONE 'UTC',
       now() AT TIME ZONE 'UTC'
FROM (
  SELECT w."user_id",
         w."date",
         w."login_at",
         w."ended_at",
         COALESCE(w."ended_at", s."last_at") AS "end_at"
  FROM "work_day_ends" w
  LEFT JOIN (
    SELECT "user_id", "date", max("at") AS "last_at"
      FROM "activity_samples"
     WHERE NOT "idle"
       AND "date" < to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
     GROUP BY 1, 2
  ) s ON s."user_id" = w."user_id" AND s."date" = w."date"
  WHERE w."login_at" IS NOT NULL
    AND w."date" < to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
) d
WHERE d."end_at" > d."login_at"
  AND NOT EXISTS (
    SELECT 1 FROM "work_sessions" x WHERE x."user_id" = d."user_id" AND x."date" = d."date"
  )
ON CONFLICT ("id") DO NOTHING;
