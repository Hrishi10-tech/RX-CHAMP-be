import { Prisma } from '@prisma/client';
import { ConflictError } from '@shared/exceptions/app.exception';

/**
 * Month locks (SPEC 1.9) as seen from a transaction.
 *
 * Every decision or reopen takes a SHARED advisory lock on its item's month and
 * then checks month_locks; locking a month takes the EXCLUSIVE lock, counts what
 * is still pending and writes the lock row. So a lock waits for decisions already
 * in flight, and once it commits every later decision sees it and is refused.
 * Advisory locks are released at the end of the transaction.
 */

function lockKey(month: string): string {
  return `rxv:month-lock:${month}`;
}

/** "2026-09-14" or "2026-09" -> "2026-09". */
export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function monthLockedError(month: string): ConflictError {
  return new ConflictError(
    `${month} is locked for payroll. A Super Admin must unlock it before anything in it changes.`,
    'MONTH_LOCKED',
  ).withDetails({ month });
}

/**
 * Shared lock on the month, then whether it is locked. Every path that creates or
 * changes a PENDING item dated in a month goes through here (or assertMonthOpen).
 */
export async function isMonthLocked(
  tx: Prisma.TransactionClient,
  dateKey: string,
): Promise<boolean> {
  const month = monthOf(dateKey);
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock_shared(hashtext(${lockKey(month)}))) AS l`;
  const locked = await tx.monthLock.findUnique({ where: { month }, select: { month: true } });
  return !!locked;
}

/** Shared lock on the month, then 409 MONTH_LOCKED when it is locked. */
export async function assertMonthOpen(
  tx: Prisma.TransactionClient,
  dateKey: string,
): Promise<void> {
  if (await isMonthLocked(tx, dateKey)) throw monthLockedError(monthOf(dateKey));
}

/** Exclusive lock on the month for the rest of the transaction (lock and unlock). */
export async function lockMonthExclusive(
  tx: Prisma.TransactionClient,
  month: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey(month)}))) AS l`;
}
