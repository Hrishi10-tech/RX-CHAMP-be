-- RX Vision 3.6: a person's last ended session (GET /me/day-progress keeps that day's ring until
-- the next Start day): one index range, whatever the size of the table. Additive.
CREATE INDEX "work_sessions_user_id_ended_at_idx" ON "work_sessions" ("user_id", "ended_at");
