import { assertMonthOpen, isMonthLocked, lockMonthExclusive, monthOf } from './month-lock';

/**
 * A fake transaction: users belong to organisations (`companies`), and `locked`
 * lists the organisation-months with a lock row ("org:YYYY-MM").
 */
function tx(locked: string[], companies: Record<string, string | null> = { u1: 'org-a', u2: 'org-b' }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const kind = strings.join('?').includes('pg_advisory_xact_lock_shared') ? 'shared-lock' : 'exclusive-lock';
        calls.push(`${kind}:${String(values[0])}`);
        return [{ ok: 1 }];
      }),
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`user:${where.id}`);
          return where.id in companies ? { companyId: companies[where.id] } : null;
        }),
      },
      monthLock: {
        findUnique: jest.fn(async ({ where }: { where: { companyId_month: { companyId: string; month: string } } }) => {
          const { companyId, month } = where.companyId_month;
          calls.push(`find:${companyId}:${month}`);
          return locked.includes(`${companyId}:${month}`) ? { month } : null;
        }),
      },
    },
  };
}

describe('month locks inside a transaction (per organisation)', () => {
  it("looks up the person's organisation, takes the shared lock on that organisation-month, then reads the lock row", async () => {
    const t = tx(['org-a:2026-08']);
    expect(await isMonthLocked(t.client as never, '2026-08-31', 'u1')).toBe(true);
    expect(t.calls).toEqual([
      'user:u1',
      'shared-lock:rxv:month-lock:org-a:2026-08',
      'find:org-a:2026-08',
    ]);
    expect(await isMonthLocked(t.client as never, '2026-09-01', 'u1')).toBe(false);
  });

  it("one organisation's lock does not lock another organisation's month", async () => {
    const t = tx(['org-a:2026-08']);
    expect(await isMonthLocked(t.client as never, '2026-08-15', 'u1')).toBe(true);
    expect(await isMonthLocked(t.client as never, '2026-08-15', 'u2')).toBe(false);
    expect(t.calls).toContain('shared-lock:rxv:month-lock:org-b:2026-08');
  });

  it('a person outside any organisation (or unknown) is never locked and takes no lock', async () => {
    const t = tx(['org-a:2026-08'], { sa: null });
    expect(await isMonthLocked(t.client as never, '2026-08-15', 'sa')).toBe(false);
    expect(await isMonthLocked(t.client as never, '2026-08-15', 'ghost')).toBe(false);
    expect(t.calls.filter((c) => c.includes('lock'))).toEqual([]);
    expect(t.client.monthLock.findUnique).not.toHaveBeenCalled();
  });

  it('assertMonthOpen answers 409 MONTH_LOCKED with the month', async () => {
    const t = tx(['org-a:2026-08']);
    await expect(assertMonthOpen(t.client as never, '2026-08-15', 'u1')).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_LOCKED',
      details: { month: '2026-08' },
    });
    await expect(assertMonthOpen(t.client as never, '2026-09-15', 'u1')).resolves.toBeUndefined();
    await expect(assertMonthOpen(t.client as never, '2026-08-15', 'u2')).resolves.toBeUndefined();
  });

  it('lockMonthExclusive takes the exclusive lock on that organisation-month only', async () => {
    const t = tx([]);
    await lockMonthExclusive(t.client as never, 'org-b', '2026-08');
    expect(t.calls).toEqual(['exclusive-lock:rxv:month-lock:org-b:2026-08']);
  });

  it('a date key or a month gives the month', () => {
    expect(monthOf('2026-08-31')).toBe('2026-08');
    expect(monthOf('2026-08')).toBe('2026-08');
  });
});
