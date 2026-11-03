-- =============================================================================
-- RX Vision 3.3 on 4.0 (1 of 2): the SUPER_MANAGER role value.
--
-- 3.3 rebuilt "RoleName" from scratch, which would drop 4.0's ADMIN value. On 4.0
-- the value is added in place instead. PostgreSQL cannot use a value added by
-- ALTER TYPE ... ADD VALUE in the same transaction, so the role row is inserted by
-- 20261103_rx33_2_super_manager. Additive: a 4.0 build keeps running on it.
-- =============================================================================
SET LOCAL lock_timeout = '15s';

ALTER TYPE "RoleName" ADD VALUE IF NOT EXISTS 'SUPER_MANAGER';
