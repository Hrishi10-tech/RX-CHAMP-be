-- RX Vision 3.6: the "In a meeting" status (brief 1.8, decisions D-20 and D-22).
-- Additive: every existing meeting stays DECLARED with the three new columns empty.

CREATE TYPE "MeetingKind" AS ENUM ('DECLARED', 'STATUS');
CREATE TYPE "MeetingStartSource" AS ENUM ('BUTTON', 'SUGGESTION');
CREATE TYPE "MeetingEndReason" AS ENUM ('USER', 'BREAK', 'END_DAY', 'NO_ANSWER', 'AUTO_CLOSED');

ALTER TABLE "meeting_records"
  ADD COLUMN "kind" "MeetingKind" NOT NULL DEFAULT 'DECLARED',
  ADD COLUMN "start_source" "MeetingStartSource",
  ADD COLUMN "confirmed_at" TIMESTAMP(3),
  ADD COLUMN "end_reason" "MeetingEndReason";

-- The minute job's read: running status meetings by when they were last confirmed.
-- Partial, so it stays tiny; Prisma cannot express it (migration SQL only).
CREATE INDEX "meeting_records_status_running_idx"
  ON "meeting_records" ("confirmed_at")
  WHERE "kind" = 'STATUS' AND "ended_at" IS NULL;
