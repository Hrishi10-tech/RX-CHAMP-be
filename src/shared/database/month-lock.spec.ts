import { assertMonthOpen, isMonthLocked, monthOf } from './month-lock';

function tx(lockedMonths: string[]) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      $queryRaw: jest.fn(async () => {
        calls.push('shared-lock');
        return [{ ok: 1 }];
      }),
      monthLock: {
        findUnique: jest.fn(async ({ where }: { where: { month: string } }) => {
          calls.push(`find:${where.month}`);
          return lockedMonths.includes(where.month) ? { month: where.month } : null;
        }),
      },
    },
  };
}

describe('month locks inside a transaction', () => {
  it('takes the shared lock on the month, then reads whether it is locked', async () => {
    const t = tx(['2026-08']);
    expect(await isMonthLocked(t.client as never, '2026-08-31')).toBe(true);
    expect(t.calls).toEqual(['shared-lock', 'find:2026-08']);
    expect(await isMonthLocked(t.client as never, '2026-09-01')).toBe(false);
  });

  it('assertMonthOpen answers 409 MONTH_LOCKED with the month', async () => {
    const t = tx(['2026-08']);
    await expect(assertMonthOpen(t.client as never, '2026-08-15')).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_LOCKED',
      details: { month: '2026-08' },
    });
    await expect(assertMonthOpen(t.client as never, '2026-09-15')).resolves.toBeUndefined();
  });

  it('a date key or a month gives the month', () => {
    expect(monthOf('2026-08-31')).toBe('2026-08');
    expect(monthOf('2026-08')).toBe('2026-08');
  });
});
