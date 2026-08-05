-- Denormalize role permissions onto the roles table.
ALTER TABLE "roles" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "roles" r
SET "permissions" = sub.codes
FROM (
  SELECT rp.role_id, array_agg(p.code ORDER BY p.code) AS codes
  FROM "role_permissions" rp
  JOIN "permissions" p ON p.id = rp.permission_id
  GROUP BY rp.role_id
) sub
WHERE r.id = sub.role_id;

DROP TABLE "role_permissions";
DROP TABLE "permissions";
