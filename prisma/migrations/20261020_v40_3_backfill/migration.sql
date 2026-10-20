-- =============================================================================
-- RX Vision 4.0 (3 of 3): data moves for organisations and departments.
-- docs/4.0/SPEC.md section 3.3. Idempotent: every step skips rows already moved.
--
--  1. The ADMIN role row.
--  2. An organisation exists; people without one join it when it is the only one.
--  3. Company-less shifts and assignments belong to an organisation.
--  4. Departments from the free-text users.department; users.department_id.
--  5. Managers get the departments of their direct reports (and their own).
--  6. Settings per organisation (key "org:<id>").
--  7. Month locks and report runs per organisation; their keys tightened.
--  8. Pending approvals routed to the Super Admin pool go to the org Admin pool.
--  9. One segment per existing break (pause and resume model).
--
-- Ids are md5-derived UUIDs so this runs on PostgreSQL 12 (no gen_random_uuid).
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- ---- 1. ADMIN role ------------------------------------------------------------
INSERT INTO "roles" ("id", "name", "permissions", "created_at", "updated_at")
SELECT md5('rxv-role-admin' || clock_timestamp()::text)::uuid, 'ADMIN', ARRAY[]::text[], now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'ADMIN');

-- ---- 2 and 3. Organisations, people and shifts ----------------------------------
DO $$
DECLARE
  n_companies int;
  only_company uuid;
  s record;
  c record;
  new_shift uuid;
BEGIN
  SELECT count(*) INTO n_companies FROM "companies" WHERE "deleted_at" IS NULL;

  IF n_companies = 0 THEN
    INSERT INTO "companies" ("id", "name", "created_at", "updated_at")
    VALUES (md5('rxv-org-default' || clock_timestamp()::text)::uuid, 'My organisation', now(), now());
    n_companies := 1;
  END IF;

  IF n_companies = 1 THEN
    SELECT "id" INTO only_company FROM "companies" WHERE "deleted_at" IS NULL ORDER BY "created_at" LIMIT 1;

    UPDATE "users" u SET "company_id" = only_company
    FROM "roles" r
    WHERE r."id" = u."role_id" AND r."name" <> 'SUPER_ADMIN' AND u."company_id" IS NULL;

    UPDATE "shifts" sh SET "company_id" = only_company,
      "is_default" = sh."is_default" AND NOT EXISTS (
        SELECT 1 FROM "shifts" d WHERE d."company_id" = only_company AND d."is_default" AND d."deleted_at" IS NULL)
    WHERE sh."company_id" IS NULL;
    UPDATE "shift_assignments" SET "company_id" = only_company WHERE "company_id" IS NULL;
  ELSE
    -- Several organisations: copy each company-less shift into every organisation
    -- and point that organisation's assignments at its copy.
    FOR s IN SELECT * FROM "shifts" WHERE "company_id" IS NULL AND "deleted_at" IS NULL LOOP
      FOR c IN SELECT "id" FROM "companies" WHERE "deleted_at" IS NULL LOOP
        new_shift := md5('rxv-shift-' || s."id"::text || c."id"::text)::uuid;
        INSERT INTO "shifts" ("id", "company_id", "name", "start", "end", "work_days", "is_default",
          "ring_lead_min", "ring_duration_min", "ring_sound", "reason_on_early", "reason_on_late",
          "reason_min_chars", "overrun_reason", "overrun_grace_min", "created_at", "updated_at")
        VALUES (new_shift, c."id", s."name", s."start", s."end", s."work_days",
          s."is_default" AND NOT EXISTS (SELECT 1 FROM "shifts" d WHERE d."company_id" = c."id" AND d."is_default" AND d."deleted_at" IS NULL),
          s."ring_lead_min", s."ring_duration_min", s."ring_sound", s."reason_on_early", s."reason_on_late",
          s."reason_min_chars", s."overrun_reason", s."overrun_grace_min", now(), now())
        ON CONFLICT ("id") DO NOTHING;

        INSERT INTO "shift_breaks" ("id", "shift_id", "kind", "enabled", "start_time", "duration_min",
          "window_before_min", "window_after_min", "allow_skip", "created_at", "updated_at")
        SELECT md5('rxv-shiftbreak-' || b."id"::text || c."id"::text)::uuid, new_shift, b."kind", b."enabled",
          b."start_time", b."duration_min", b."window_before_min", b."window_after_min", b."allow_skip", now(), now()
        FROM "shift_breaks" b WHERE b."shift_id" = s."id"
        ON CONFLICT ("id") DO NOTHING;

        UPDATE "shift_assignments" a SET "shift_id" = new_shift, "company_id" = c."id"
        WHERE a."shift_id" = s."id" AND a."target" = 'USER'
          AND a."user_id" IN (SELECT "id" FROM "users" WHERE "company_id" = c."id");

        UPDATE "shift_assignments" a SET "shift_id" = new_shift
        WHERE a."shift_id" = s."id" AND a."target" = 'DEPARTMENT' AND a."company_id" = c."id";

        INSERT INTO "shift_assignments" ("id", "target", "company_id", "department", "department_key", "user_id",
          "shift_id", "effective_from", "effective_to", "created_by_id", "created_at")
        SELECT md5('rxv-assign-' || a."id"::text || c."id"::text)::uuid, a."target", c."id", a."department",
          a."department_key", NULL, new_shift, a."effective_from", a."effective_to", a."created_by_id", a."created_at"
        FROM "shift_assignments" a
        WHERE a."shift_id" = s."id" AND a."target" = 'DEPARTMENT' AND a."company_id" IS NULL
        ON CONFLICT ("id") DO NOTHING;
      END LOOP;

      DELETE FROM "shift_assignments" WHERE "shift_id" = s."id" AND "target" = 'DEPARTMENT' AND "company_id" IS NULL;
      UPDATE "shifts" SET "deleted_at" = now(), "is_default" = false WHERE "id" = s."id";
    END LOOP;

    INSERT INTO "shift_assignments" ("id", "target", "company_id", "department", "department_key", "user_id",
      "shift_id", "effective_from", "effective_to", "created_by_id", "created_at")
    SELECT md5('rxv-assign-' || a."id"::text || co."id"::text)::uuid, a."target", co."id", a."department", a."department_key", NULL,
      a."shift_id", a."effective_from", a."effective_to", a."created_by_id", a."created_at"
    FROM "shift_assignments" a CROSS JOIN "companies" co
    WHERE a."company_id" IS NULL AND a."target" = 'DEPARTMENT' AND co."deleted_at" IS NULL
    ON CONFLICT ("id") DO NOTHING;
    DELETE FROM "shift_assignments" WHERE "company_id" IS NULL AND "target" = 'DEPARTMENT';

    -- Company-less "back to department" rows (shift_id NULL) apply in every organisation: attach by the person.
    UPDATE "shift_assignments" a SET "company_id" = u."company_id"
    FROM "users" u WHERE a."company_id" IS NULL AND a."user_id" = u."id" AND u."company_id" IS NOT NULL;
  END IF;
END $$;

-- ---- 4. Departments from the free text ------------------------------------------
INSERT INTO "departments" ("id", "company_id", "name", "icon", "created_at", "updated_at")
SELECT md5('rxv-dept-' || g.company_id::text || g.dept_key)::uuid, g.company_id, g.name,
  CASE
    WHEN g.dept_key ~ '(electronic|hardware|pcb|embedded)' THEN 'circuit-board'
    WHEN g.dept_key ~ '(engineer|develop|software|tech|\mit\M)' THEN 'code'
    WHEN g.dept_key ~ '(r&d|r & d|research)' THEN 'flask'
    WHEN g.dept_key ~ '(quality|\mqa\M|qms)' THEN 'badge-check'
    WHEN g.dept_key ~ '(regulat|compliance|legal)' THEN 'scale'
    WHEN g.dept_key ~ '(sales|business)' THEN 'bar-chart'
    WHEN g.dept_key ~ 'market' THEN 'megaphone'
    WHEN g.dept_key ~ '(support|service|customer)' THEN 'headphones'
    WHEN g.dept_key ~ '(\mhr\M|human|people|talent)' THEN 'users'
    WHEN g.dept_key ~ '(financ|account)' THEN 'wallet'
    WHEN g.dept_key ~ '(design|creative)' THEN 'palette'
    WHEN g.dept_key ~ '(production|manufactur|assembly)' THEN 'factory'
    WHEN g.dept_key ~ '(procure|purchas|inventory|store|warehouse)' THEN 'boxes'
    WHEN g.dept_key ~ '(logistic|dispatch|shipping)' THEN 'truck'
    WHEN g.dept_key ~ '(clinical|medical|health)' THEN 'stethoscope'
    WHEN g.dept_key ~ '(operation|admin)' THEN 'settings'
    ELSE 'briefcase'
  END,
  now(), now()
FROM (
  SELECT u."company_id" AS company_id,
         lower(btrim(regexp_replace(u."department", '\s+', ' ', 'g'))) AS dept_key,
         min(btrim(regexp_replace(u."department", '\s+', ' ', 'g'))) AS name
  FROM "users" u
  WHERE u."deleted_at" IS NULL AND u."company_id" IS NOT NULL AND btrim(regexp_replace(u."department", '\s+', ' ', 'g')) <> ''
  GROUP BY 1, 2
) g
WHERE NOT EXISTS (
  SELECT 1 FROM "departments" d
  WHERE d."company_id" = g.company_id AND d."deleted_at" IS NULL
    AND lower(regexp_replace(btrim(d."name"), '\s+', ' ', 'g')) = g.dept_key
);

UPDATE "users" u SET "department_id" = d."id"
FROM "departments" d
WHERE u."department_id" IS NULL AND u."company_id" = d."company_id" AND d."deleted_at" IS NULL
  AND btrim(regexp_replace(u."department", '\s+', ' ', 'g')) <> ''
  AND lower(btrim(regexp_replace(u."department", '\s+', ' ', 'g'))) = lower(regexp_replace(btrim(d."name"), '\s+', ' ', 'g'));

-- ---- 5. Managers' departments -----------------------------------------------------
INSERT INTO "manager_departments" ("manager_id", "department_id", "created_at")
SELECT DISTINCT m."id", r."department_id", now()
FROM "users" m
JOIN "roles" mr ON mr."id" = m."role_id" AND mr."name" = 'MANAGER'
JOIN "users" r ON r."manager_id" = m."id" AND r."deleted_at" IS NULL AND r."department_id" IS NOT NULL
               AND r."company_id" = m."company_id"
WHERE m."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "manager_departments" ("manager_id", "department_id", "created_at")
SELECT m."id", m."department_id", now()
FROM "users" m JOIN "roles" mr ON mr."id" = m."role_id" AND mr."name" = 'MANAGER'
WHERE m."deleted_at" IS NULL AND m."department_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---- 6. Settings per organisation ---------------------------------------------------
INSERT INTO "app_settings" ("key", "value", "updated_by_id", "updated_at")
SELECT 'org:' || c."id"::text, s."value", s."updated_by_id", now()
FROM "companies" c CROSS JOIN "app_settings" s
WHERE s."key" = 'org' AND c."deleted_at" IS NULL
ON CONFLICT ("key") DO NOTHING;

-- ---- 7. Month locks and report runs per organisation ------------------------------
-- A 3.1 lock or run covered everyone; it now applies to each organisation.
ALTER TABLE "month_locks" DROP CONSTRAINT IF EXISTS "month_locks_pkey";
INSERT INTO "month_locks" ("company_id", "month", "locked_by_id", "locked_at", "snapshot")
SELECT c."id", l."month", l."locked_by_id", l."locked_at", l."snapshot"
FROM "month_locks" l CROSS JOIN "companies" c
WHERE l."company_id" IS NULL AND c."deleted_at" IS NULL;
DELETE FROM "month_locks" WHERE "company_id" IS NULL;
ALTER TABLE "month_locks" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "month_locks" ADD CONSTRAINT "month_locks_pkey" PRIMARY KEY ("company_id", "month");

INSERT INTO "report_runs" ("id", "company_id", "month", "scope", "owner_id", "generated_at", "summary")
SELECT md5('rxv-run-' || r."id"::text || c."id"::text)::uuid, c."id", r."month", r."scope", r."owner_id", r."generated_at", r."summary"
FROM "report_runs" r CROSS JOIN "companies" c
WHERE r."company_id" IS NULL AND c."deleted_at" IS NULL
ON CONFLICT ("id") DO NOTHING;
DELETE FROM "report_runs" WHERE "company_id" IS NULL;
ALTER TABLE "report_runs" ALTER COLUMN "company_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "report_runs_company_id_month_scope_owner_id_key"
  ON "report_runs"("company_id", "month", "scope", "owner_id");

-- ---- 8. Approval pool --------------------------------------------------------------
UPDATE "break_records" SET "approver_role" = 'ADMIN'
WHERE "approver_role" = 'SUPER_ADMIN' AND "approval_status" = 'PENDING';
UPDATE "meeting_records" SET "approver_role" = 'ADMIN'
WHERE "approver_role" = 'SUPER_ADMIN' AND "approval_status" = 'PENDING';

-- ---- 9. Break segments ----------------------------------------------------------------
INSERT INTO "break_segments" ("id", "break_record_id", "presence_session_id", "started_at", "ended_at", "created_at")
SELECT md5('rxv-seg-' || b."id"::text)::uuid, b."id", b."presence_session_id", p."started_at", p."ended_at", now()
FROM "break_records" b
JOIN "presence_sessions" p ON p."id" = b."presence_session_id"
WHERE b."outcome" = 'TAKEN'
  AND NOT EXISTS (SELECT 1 FROM "break_segments" s WHERE s."break_record_id" = b."id");

UPDATE "break_records" b
SET "state" = CASE WHEN p."ended_at" IS NULL THEN 'ACTIVE'::"BreakState" ELSE 'ENDED'::"BreakState" END,
    "ended_at" = p."ended_at",
    "taken_sec" = CASE WHEN p."ended_at" IS NULL THEN NULL
                       ELSE GREATEST(0, round(extract(epoch FROM (p."ended_at" - p."started_at"))))::int END
FROM "presence_sessions" p
WHERE p."id" = b."presence_session_id" AND b."outcome" = 'TAKEN' AND b."taken_sec" IS NULL AND b."ended_at" IS NULL;
