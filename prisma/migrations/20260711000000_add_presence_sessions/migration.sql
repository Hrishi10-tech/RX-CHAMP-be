-- CreateEnum
CREATE TYPE "PresenceType" AS ENUM ('BREAK', 'LUNCH', 'MEETING');

-- CreateTable
CREATE TABLE "presence_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "type" "PresenceType" NOT NULL,
    "note" TEXT,
    "date" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presence_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "presence_sessions_user_id_idx" ON "presence_sessions"("user_id");

-- CreateIndex
CREATE INDEX "presence_sessions_date_idx" ON "presence_sessions"("date");

-- CreateIndex
CREATE INDEX "presence_sessions_user_id_date_idx" ON "presence_sessions"("user_id", "date");

-- CreateIndex
CREATE INDEX "presence_sessions_user_id_ended_at_idx" ON "presence_sessions"("user_id", "ended_at");

-- AddForeignKey
ALTER TABLE "presence_sessions" ADD CONSTRAINT "presence_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
