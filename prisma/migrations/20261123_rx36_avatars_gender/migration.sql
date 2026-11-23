-- =============================================================================
-- RX Vision 3.6: preset avatars.
--
-- Additive: one enum and two empty columns on "users", no rewrite of existing rows
-- and no default, so it is instant and safe while the 3.5 API runs. Nobody has a
-- gender until a Super Admin sets one; until then they show initials.
--
-- Reverse:
--   ALTER TABLE "users" DROP COLUMN "avatar_id", DROP COLUMN "gender";
--   DROP TYPE "Gender";
-- =============================================================================
SET LOCAL lock_timeout = '15s';

CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

ALTER TABLE "users"
  ADD COLUMN "gender" "Gender",
  ADD COLUMN "avatar_id" TEXT;
