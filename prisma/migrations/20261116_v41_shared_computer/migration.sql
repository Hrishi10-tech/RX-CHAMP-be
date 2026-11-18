-- =============================================================================
-- RX Vision 4.1: shared computers. A department can be marked as sharing one
-- computer between shifts; a work session records when its person chose to
-- carry on into the next shift. Additive: no existing row changes.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

ALTER TABLE "departments" ADD COLUMN "shared_computer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "work_sessions" ADD COLUMN "extended_at" TIMESTAMP(3);
