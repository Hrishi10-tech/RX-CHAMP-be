-- RX Vision 3.2, ported to 4.0: why a day started late (late start reason).
-- Additive: two nullable columns, no rewrite of existing rows.
ALTER TABLE "work_sessions" ADD COLUMN "late_reason" TEXT,
ADD COLUMN "late_reason_at" TIMESTAMP(3);
