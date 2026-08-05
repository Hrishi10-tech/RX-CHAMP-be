-- CreateTable
CREATE TABLE "work_day_ends" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_day_ends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_day_ends_user_id_idx" ON "work_day_ends"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_day_ends_user_id_date_key" ON "work_day_ends"("user_id", "date");

-- AddForeignKey
ALTER TABLE "work_day_ends" ADD CONSTRAINT "work_day_ends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
