-- =============================================================================
-- RX Vision 4.0 (1 of 3): enum values and new enum types only.
--
-- PostgreSQL cannot use a value added by ALTER TYPE ... ADD VALUE in the same
-- transaction, and Prisma runs each migration file as one implicit transaction,
-- so the new values are added here and first used by 20261020_v40_3_backfill.
-- Additive: a 3.1 build keeps running on it.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

ALTER TYPE "RoleName" ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE "BreakKind" ADD VALUE IF NOT EXISTS 'QUICK';

CREATE TYPE "BreakState" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');
CREATE TYPE "AwayStatus" AS ENUM ('UNEXPLAINED', 'PENDING', 'APPROVED', 'REJECTED', 'NOT_REQUIRED');
CREATE TYPE "SignOutScope" AS ENUM ('USERS', 'DEPARTMENTS', 'ORG');
