-- AlterTable
ALTER TABLE "screenshots" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "ocr_text" TEXT;
