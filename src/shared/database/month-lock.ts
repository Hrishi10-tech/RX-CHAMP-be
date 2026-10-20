import { Prisma } from '@prisma/client';
import { ConflictError } from '@shared/exceptions/app.exception';

/**
 * Month locks (SPEC 1.9), per organisation since 4.0 (docs/4.0/SPEC.md 5.8).
 *
 * Every decision or reopen takes a SHARED advisory lock on its item's organisation
 * and month and then checks month_locks; locking a month takes the EXCLUSIVE lock,
 * counts what is still pending and writes the lock row. So a lock waits for
 * decisions already in flight, and once it commits every later decision sees it
 * and is refused. Advisory locks are released at the end of the transaction.
 *
 * A person outside any organisation (a platform Super Admin) is never locked.
 */

function lockKey(companyId: string, month: string): string {
  return `rxv:month-lock:${companyId}:${month}`;
}

/** "2026-09-14" or "2026-09" -> "2026-09". */
export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function monthLockedError(month: string): ConflictError {
  return new ConflictError(
    `${month} is locked for payroll. The organisation admin must unlock it before anything in it changes.`,
    'MONTH_LOCKED',
  ).withDetails({ month });
}

/** The organisation a person belongs to, read inside the transaction. */
async function companyOfUser(tx: Prisma.TransactionClient, userId: string): Promise<string | null> {
  const row = await tx.user.findUnique({ where: { id: userId }, select: { companyId: true } });
  return row?.companyId ?? null;
}

/**
 * Shared lock on the person's organisation-month, then whether it is locked. Every
 * path that creates or changes a PENDING item dated in a month goes through here
 * (or assertMonthOpen).
 */
export async function isMonthLocked(
  tx: Prisma.TransactionClient,
  dateKey: string,
  userId: string,
): Promise<boolean> {
  const companyId = await companyOfUser(tx, userId);
  if (!companyId) return false;
  const month = monthOf(dateKey);
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock_shared(hashtext(${lockKey(companyId, month)}))) AS l`;
  const locked = await tx.monthLock.findUnique({
    where: { companyId_month: { companyId, month } },
    select: { month: true },
  });
  return !!locked;
}

/** Shared lock on the person's organisation-month, then 409 MONTH_LOCKED when it is locked. */
export async function assertMonthOpen(
  tx: Prisma.TransactionClient,
  dateKey: string,
  userId: string,
): Promise<void> {
  if (await isMonthLocked(tx, dateKey, userId)) throw monthLockedError(monthOf(dateKey));
}

/** Exclusive lock on an organisation-month for the rest of the transaction (lock and unlock). */
export async function lockMonthExclusive(
  tx: Prisma.TransactionClient,
  companyId: string,
  month: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey(companyId, month)}))) AS l`;
}
