-- RX Vision 3.6 on 4.0: the payroll pause for biometric staff (brief 1.6).
--
-- 4.0: each organisation runs its own biometric integration, so the history of when
-- it was on is kept per organisation (company_id).
--
-- Additive: no row means the organisation's integration has never been on, so its
-- biometric staff's payroll is paused until its admin switches it on; nobody else is
-- touched.

CREATE TABLE "biometric_integration_periods" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "from_date" TEXT NOT NULL,
  "to_date" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "started_by_id" UUID,
  "ended_by_id" UUID,

  CONSTRAINT "biometric_integration_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "biometric_integration_periods_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "biometric_integration_periods_company_id_from_date_idx"
  ON "biometric_integration_periods" ("company_id", "from_date");

-- At most one period open at a time per organisation (Prisma cannot express this).
CREATE UNIQUE INDEX "biometric_integration_periods_one_open"
  ON "biometric_integration_periods" ("company_id")
  WHERE "to_date" IS NULL;
