-- =============================================================================
-- RX Vision 3.3 on 4.0 (2 of 2): the Super Manager role row, manual focus
-- adjustments and agent diagnostics. Additive: no existing row changes.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

INSERT INTO "roles" ("id", "name", "permissions", "created_at", "updated_at")
SELECT md5(random()::text || clock_timestamp()::text || 'SUPER_MANAGER')::uuid, 'SUPER_MANAGER'::"RoleName",
       ARRAY['CREATE_USER','UPDATE_USER','DELETE_USER','VIEW_TEAM','VIEW_REPORT','ASSIGN_MEMBER','VIEW_SCREENSHOTS','SEND_CHAT']::text[],
       now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "roles" x WHERE x."name"::text = 'SUPER_MANAGER');

-- ---- Manual focus adjustments ------------------------------------------------
CREATE TABLE "focus_adjustments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "delta_sec" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" UUID,

    CONSTRAINT "focus_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "focus_adjustments_user_id_date_idx" ON "focus_adjustments"("user_id", "date");
CREATE INDEX "focus_adjustments_date_idx" ON "focus_adjustments"("date");
CREATE INDEX "focus_adjustments_created_at_idx" ON "focus_adjustments"("created_at");

-- ---- Agent diagnostics ---------------------------------------------------------
-- One row per person: when their agent last called, which agent it was, and the
-- last screenshot upload the server refused (and why). Read by GET /agent-health.
CREATE TABLE "agent_contacts" (
    "user_id" UUID NOT NULL,
    "last_contact_at" TIMESTAMP(3) NOT NULL,
    "user_agent" TEXT,
    "last_refusal_at" TIMESTAMP(3),
    "last_refusal_status" INTEGER,
    "last_refusal_code" TEXT,
    "last_refusal_reason" TEXT,
    "last_refusal_bytes" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_contacts_pkey" PRIMARY KEY ("user_id")
);
