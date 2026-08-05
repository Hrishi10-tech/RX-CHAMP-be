-- CreateTable
CREATE TABLE "online_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "date" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "online_sessions_user_id_idx" ON "online_sessions"("user_id");

-- CreateIndex
CREATE INDEX "online_sessions_user_id_date_idx" ON "online_sessions"("user_id", "date");

-- CreateIndex
CREATE INDEX "online_sessions_user_id_ended_at_idx" ON "online_sessions"("user_id", "ended_at");

-- AddForeignKey
ALTER TABLE "online_sessions" ADD CONSTRAINT "online_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
