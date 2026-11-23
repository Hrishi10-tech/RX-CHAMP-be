-- RX Vision 3.6: stretches someone was on biometric, written when they move back to the agent.
-- Their source on a past date stays what it was, so a change of source never recalculates the
-- days before it (brief 1.6: past periods are not recalculated by themselves).
-- Additive: no row means nothing is known of an earlier stretch, and the days read as they did.
CREATE TABLE "biometric_source_periods" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "from_date" TEXT,
  "to_date" TEXT NOT NULL,
  "changed_at" TIMESTAMP(3) NOT NULL,
  "changed_by_id" UUID,

  CONSTRAINT "biometric_source_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "biometric_source_periods_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "biometric_source_periods_user_id_to_date_idx"
  ON "biometric_source_periods" ("user_id", "to_date");
