import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { redactActivity } from '@modules/activity/application/activity-redaction';
import { PresenceMapper } from '@modules/presence/application/presence.mapper';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { DEFAULT_SETTINGS } from '@modules/settings/domain/settings.rules';
import { WorkdayService } from './workday.service';

const NOW = new Date('2026-10-14T13:00:00.000Z');
const me = (id: string, role: Role): AuthenticatedUser =>
  ({
    id,
    email: `${id}@x.test`,
    role,
    permissions: [],
    department: null,
    companyId: 'co-1',
    status: 'ACTIVE',
  }) as AuthenticatedUser;

describe('WorkdayService End Day gates', () => {
  function setup(overdue = { count: 0, oldestDueAt: null as Date | null }, block = true) {
    const approvals = { overdueRoutedTo: jest.fn().mockResolvedValue(overdue) };
    const skipsQuery = { forUser: jest.fn().mockResolvedValue([]) };
    const settings = {
      get: jest
        .fn()
        .mockResolvedValue({ ...DEFAULT_SETTINGS, blockManagerEndDayWhenOverdue: block }),
    };
    const svc = new WorkdayService(
      {} as never,
      approvals as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      skipsQuery as never,
      settings as never,
      {} as never,
    );
    return { svc, approvals, skipsQuery };
  }

  it('lists every skip still waiting for a comment', async () => {
    const { svc, skipsQuery } = setup();
    const breaks = [
      { breakId: 'b1', date: '2026-10-13', kind: 'MORNING' },
      { breakId: 'b2', date: '2026-10-14', kind: 'EVENING' },
    ];
    skipsQuery.forUser.mockResolvedValue(breaks);
    await expect(svc.assertCanEndDay(me('u1', Role.USER), NOW)).rejects.toMatchObject({
      status: 409,
      code: 'SKIP_COMMENTS_REQUIRED',
      message: 'Add a comment to each of your 2 skipped breaks before you end the day.',
      details: { breaks },
    });
  });

  it('stops a Manager with overdue approvals while the setting is on', async () => {
    const oldest = new Date('2026-10-12T05:00:00.000Z');
    const { svc } = setup({ count: 3, oldestDueAt: oldest });
    await expect(svc.assertCanEndDay(me('m1', Role.MANAGER), NOW)).rejects.toMatchObject({
      status: 409,
      code: 'APPROVALS_OVERDUE',
      message: '3 approvals are past 48 hours. Decide them in the portal to end your day.',
      details: { count: 3, oldestDueAt: oldest.toISOString() },
    });
  });

  it('never stops a Super Admin or staff on approvals, nor a Manager with the setting off', async () => {
    const busy = { count: 5, oldestDueAt: new Date() };
    await expect(
      setup(busy).svc.assertCanEndDay(me('sa', Role.SUPER_ADMIN), NOW),
    ).resolves.toBeUndefined();
    await expect(
      setup(busy).svc.assertCanEndDay(me('u1', Role.USER), NOW),
    ).resolves.toBeUndefined();
    const off = setup(busy, false);
    await expect(off.svc.assertCanEndDay(me('m1', Role.MANAGER), NOW)).resolves.toBeUndefined();
    expect(off.approvals.overdueRoutedTo).not.toHaveBeenCalled();
  });
});

describe('WorkdayService view: the day that ended', () => {
  // India is UTC+05:30.
  const ist = (date: string, hm: string) => {
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = hm.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, h, mi) - 330 * 60_000);
  };
  const ended = {
    id: 's1',
    userId: 'u1',
    date: '2026-10-14',
    startedAt: ist('2026-10-14', '09:30'),
    endedAt: ist('2026-10-14', '18:30'),
    endReason: 'USER' as const,
    source: 'AGENT' as const,
  };
  function setup(todayKey: string) {
    const sessions = {
      findOpen: jest.fn().mockResolvedValue(null),
      findLastEnded: jest.fn().mockResolvedValue(ended),
    };
    const approvals = { overdueRoutedTo: jest.fn().mockResolvedValue({ count: 0 }) };
    const people = { findById: jest.fn().mockResolvedValue({ id: 'u1', role: 'USER' }) };
    const dayData = {
      load: jest.fn(async () => ({
        day: (userId: string, date: string) => ({
          userId,
          date,
          sessions: date === ended.date ? [ended] : [],
          presence: [],
          breakRecords: [],
          meetingRecords: [],
        }),
      })),
    };
    const days = {
      context: jest.fn().mockResolvedValue({}),
      dayWith: jest.fn().mockReturnValue({ dateKey: todayKey }),
      resolveWith: jest.fn().mockReturnValue({ shift: null }),
    };
    const svc = new WorkdayService(
      sessions as never,
      approvals as never,
      people as never,
      {} as never,
      {} as never,
      dayData as never,
      days as never,
      { forUser: jest.fn().mockResolvedValue([]) } as never,
      { get: jest.fn().mockResolvedValue(DEFAULT_SETTINGS) } as never,
      { get: jest.fn() } as never,
    );
    return { svc, sessions };
  }

  it('End Day after midnight answers with the day it ended: its date, ENDED, its focus', async () => {
    const { svc } = setup('2026-10-15');
    const view = await svc.view(me('u1', Role.USER), ist('2026-10-15', '00:30'), '2026-10-14');
    expect(view).toMatchObject({
      date: '2026-10-14',
      state: 'ENDED',
      endedAt: ended.endedAt.toISOString(),
      lastEnded: null,
    });
    expect(view.focus.focusSec).toBe(9 * 3600);
  });

  it('a new working day not started yet shows the day ended within 12 hours', async () => {
    const { svc } = setup('2026-10-15');
    const view = await svc.view(me('u1', Role.USER), ist('2026-10-15', '06:29'));
    expect(view).toMatchObject({ date: '2026-10-15', state: 'NOT_STARTED' });
    expect(view.focus.focusSec).toBe(0);
    expect(view.lastEnded).toEqual({
      date: '2026-10-14',
      endedAt: ended.endedAt.toISOString(),
      focusSec: 9 * 3600,
    });
  });

  it('nothing after 12 hours, and nothing for a day that is open or ended today', async () => {
    const late = setup('2026-10-15');
    expect((await late.svc.view(me('u1', Role.USER), ist('2026-10-15', '06:31'))).lastEnded).toBe(
      null,
    );
    const same = setup('2026-10-14');
    const view = await same.svc.view(me('u1', Role.USER), ist('2026-10-14', '19:00'));
    expect(view).toMatchObject({ state: 'ENDED', lastEnded: null });
    expect(same.sessions.findLastEnded).not.toHaveBeenCalled();
  });
});

describe('AppSettingsService', () => {
  it('reads defaults, caches reads, and refuses out-of-range values naming the field', async () => {
    const store = {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new AppSettingsService(store as never);
    expect(await svc.get()).toEqual(DEFAULT_SETTINGS);
    await svc.get();
    expect(store.read).toHaveBeenCalledTimes(1);

    await expect(svc.update({ approvalSlaHours: 6 }, 'sa')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      details: { field: 'approvalSlaHours' },
    });
    await expect(svc.update({ halfDayPct: 90 }, 'sa')).rejects.toMatchObject({
      details: { field: 'halfDayPct' },
    });
    expect(store.write).not.toHaveBeenCalled();

    const saved = await svc.update({ approvalSlaHours: 24, quietHoursFlag: 6 }, 'sa');
    expect(saved).toMatchObject({ approvalSlaHours: 24, quietHoursFlag: 6, fullDayPct: 80 });
    expect(store.write).toHaveBeenCalledWith('org', saved, 'sa');
    // The write refreshed the cache: no read needed.
    const reads = store.read.mock.calls.length;
    expect(await svc.get()).toEqual(saved);
    expect(store.read).toHaveBeenCalledTimes(reads);
  });
});

describe('what staff and older clients see', () => {
  it('staff get their day without activity numbers (same shape, 200)', () => {
    const daily = {
      date: '2026-10-14',
      activeSec: 20000,
      idleSec: 3000,
      extraSec: 100,
      workingBasisSec: 32400,
      remainingSec: 12400,
      clockedOut: true,
      topApps: [{ app: 'Excel', sec: 100 }],
      topWebsites: [{ host: 'x.test', sec: 10 }],
      hourly: [{ hour: 10, activeSec: 3000 }],
    };
    expect(redactActivity(daily as never)).toMatchObject({
      date: '2026-10-14',
      activeSec: 0,
      idleSec: 0,
      extraSec: 0,
      remainingSec: 32400,
      clockedOut: false,
      topApps: [],
      topWebsites: [],
      hourly: [],
    });
  });

  it('presence says NOT_STARTED before the first Start Day, and DAY_ENDED wins', () => {
    const now = new Date();
    expect(PresenceMapper.currentFrom(null, now, false, true).status).toBe('NOT_STARTED');
    expect(PresenceMapper.currentFrom(null, now, false, false).status).toBe('WORKING');
    expect(PresenceMapper.currentFrom(null, now, true, true).status).toBe('DAY_ENDED');
  });
});
