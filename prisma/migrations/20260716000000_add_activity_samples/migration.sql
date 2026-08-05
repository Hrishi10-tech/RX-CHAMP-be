-- CreateTable
CREATE TABLE "activity_samples" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "date" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "idle" BOOLEAN NOT NULL DEFAULT false,
    "app" TEXT,
    "title" TEXT,
    "url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_samples_user_id_date_idx" ON "activity_samples"("user_id", "date");

-- CreateIndex
CREATE INDEX "activity_samples_user_id_at_idx" ON "activity_samples"("user_id", "at");

-- AddForeignKey
ALTER TABLE "activity_samples" ADD CONSTRAINT "activity_samples_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
