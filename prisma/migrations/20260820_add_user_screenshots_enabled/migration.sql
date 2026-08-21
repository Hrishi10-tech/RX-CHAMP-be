-- Per-user switch for automatic screenshots. Off stops only the agent's periodic
-- capture: activity tracking keeps running, and a manager's manual capture still
-- works. Defaults true so every existing user carries on exactly as before.
ALTER TABLE "users" ADD COLUMN "screenshots_enabled" BOOLEAN NOT NULL DEFAULT true;
