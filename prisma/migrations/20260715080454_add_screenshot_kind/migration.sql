-- CreateEnum
CREATE TYPE "ScreenshotKind" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "screenshots" ADD COLUMN     "kind" "ScreenshotKind" NOT NULL DEFAULT 'AUTO';

-- CreateIndex
CREATE INDEX "screenshots_taken_at_idx" ON "screenshots"("taken_at");
