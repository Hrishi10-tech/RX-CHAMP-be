-- Who caused a notification, when that is a person rather than the system: the
-- sender of a chat message, for instance. Clients use it to open that person's
-- conversation straight from the toast. Nullable, because most notifications
-- (day ended, company assigned) have no human sender.
ALTER TABLE "notifications" ADD COLUMN "from_user_id" UUID;
