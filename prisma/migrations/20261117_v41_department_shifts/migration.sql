-- 4.1: a department can run several shifts; Start Day picks one by the time.
ALTER TABLE "shift_assignments" ADD COLUMN "auto_picked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "department_shifts" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "department_key" TEXT NOT NULL,
    "shift_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "department_shifts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "department_shifts_company_id_department_key_shift_id_key" ON "department_shifts"("company_id", "department_key", "shift_id");
CREATE INDEX "department_shifts_department_key_idx" ON "department_shifts"("department_key");

ALTER TABLE "department_shifts" ADD CONSTRAINT "department_shifts_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
