import { OrgCalendar, PATTERN_SINCE_ALWAYS } from '@modules/calendar/domain/calendar.rules';
import { DayPlanService } from './day-plan.service';

/** 4.0 (audit M2): a person's day plan follows the week pattern in force on that date. */
describe('DayPlanService: the week pattern of each date', () => {
  it('a Saturday before the change is a working day with a target; one after it is off', async () => {
    const cal: OrgCalendar = {
      weekPattern: [1, 2, 3, 4, 5],
      patterns: [
        { from: PATTERN_SINCE_ALWAYS, days: [1, 2, 3, 4, 5, 6] },
        { from: '2026-10-19', days: [1, 2, 3, 4, 5] },
      ],
      overrides: new Map(),
    };
    const days = {
      context: jest.fn().mockResolvedValue({}),
      resolveWith: jest.fn().mockReturnValue({ shift: null }),
    };
    const calendar = {
      forOrg: jest.fn(async (c: string | null) =>
        c ? cal : { weekPattern: [1, 2, 3, 4, 5, 6], overrides: new Map() },
      ),
    };
    const settings = { get: jest.fn().mockResolvedValue({ breakBufferMin: 10 }) };
    const svc = new DayPlanService(days as never, calendar as never, settings as never);
    const person = { id: 'u1', companyId: 'c1', department: 'Billing' };
    const pc = await svc.context([person]);
    const before = pc.plan(person, '2026-10-17');
    const after = pc.plan(person, '2026-10-24');
    expect(before.isWorkingDay).toBe(true);
    expect(before.targetSec).toBeGreaterThan(0);
    expect(after).toMatchObject({ isWorkingDay: false, targetSec: 0 });
  });
});
