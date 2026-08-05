-- Workstation-locked flag on activity samples.
--
-- Additive and backward compatible: existing rows and any agent that doesn't send
-- the field default to false, which is exactly the old behaviour.
ALTER TABLE "activity_samples"
  ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
