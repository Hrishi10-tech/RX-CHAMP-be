import { Prisma } from '@prisma/client';
import { NotFoundError } from '@shared/exceptions/app.exception';

/**
 * Locks an organisation's row (SELECT ... FOR UPDATE) for the rest of the
 * transaction, if it exists and is not deleted. Deleting an organisation and
 * every write that adds to one (a person, a department, assigning someone, its
 * Admin) take this lock first, so a delete and an addition never interleave: an
 * addition that waited for a delete finds the organisation gone, and a delete that
 * waited for an addition counts the new person. False when there is no such
 * organisation (refuse with orgNotFound()).
 */
export async function lockOrganisation(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM companies
     WHERE id = ${companyId}::uuid AND deleted_at IS NULL
       FOR UPDATE`;
  return rows.length > 0;
}

/** 404 ORG_NOT_FOUND: the organisation does not exist (or was deleted). */
export function orgNotFound(): NotFoundError {
  return new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');
}
