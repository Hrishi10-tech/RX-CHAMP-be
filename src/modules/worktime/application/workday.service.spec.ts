import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { redactActivity } from '@modules/activity/application/activity-redaction';
import { PresenceMapper } from '@modules/presence/application/presence.mapper';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { DEFAULT_SETTINGS } from '@modules/settings/domain/settings.rules';
import { effectiveIdle, idleFromStored } from '@modules/settings/domain/idle.rules';
import { DayPlan } from './day-plan.service';
import { WorkdayService } from './workday.service';

const NOW = new Date('2026-10-14T13:00:00.000Z');
const me = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id,
    email: `${id}@x.test`,
    role,
    permissions: [],
    department: null,
    companyId: 'co-1',
    status: 'ACTIVE',
    orgId: role === Role.SUPER_ADMIN ? null : 'co-1',
    departmentId: role === Role.USER ? 'dept-1' : null,
    managedDepartmentIds: role === Role.MANAGER ? ['dept-1', 'dept-2'] : [],
    ...over,
  }) as AuthenticatedUser;

/** The constructor's eleven collaborators, each replaceable. */
function build(over: Partial<Record<string, unknown>> = {}) {
  const deps = {
    sessions: {},
    approvals: {},
    people: {},
    workSessions: {},
    skips: {},
    dayData: {},
    days: {},
    skipsQuery: { forUser: jest.fn().mockResolvedValue([]) },
    settings: { get: jest.fn().mockResolvedValue(DEFAULT_SETTINGS), effectiveIdleFor: jest.fn() },
    config: { get: jest.fn() },
    plans: {},
    ...over,
  };
  const svc = new WorkdayService(
    deps.sessions as never,
    deps.approvals as never,
    deps.people as never,
    deps.workSessions as never,
    deps.skips as never,
    deps.dayData as never,
    deps.days as never,
    deps.skipsQuery as never,
    deps.settings as never,
    deps.config as never,
    deps.plans as never,
  );
  return { svc, deps };
}

describe('WorkdayService End Day gates', () => {
  function setup(overdue = { count: 0, oldestDueAt: null as Date | null }, block = true) {
    const approvals = { overdueIn: jest.fn().mockResolvedValue(overdue) };
    const skipsQuery = { forUser: jest.fn().mockResolvedValue([]) };
    const settings = {
      get: jest.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, blockManagerEndDayWhenOverdue: block }),
    };
    const { svc } = build({ approvals, skipsQuery, settings });
    return { svc, approvals, skipsQuery, settings };
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
    skipsQuery.forUser.mockResolvedValue([breaks[0]]);
    await expect(svc.assertCanEndDay(me('u1', Role.USER), NOW)).rejects.toMatchObject({
      message: 'Add a comment to your skipped break before you end the day.',
    });
  });

  it("stops a Manager with overdue approvals in their departments while the organisation's setting is on", async () => {
    const oldest = new Date('2026-10-12T05:00:00.000Z');
    const { svc, approvals, settings } = setup({ count: 3, oldestDueAt: oldest });
    await expect(svc.assertCanEndDay(me('m1', Role.MANAGER), NOW)).rejects.toMatchObject({
      status: 409,
      code: 'APPROVALS_OVERDUE',
      message: '3 approvals are past 48 hours. Decide them in the portal to end your day.',
      details: { count: 3, oldestDueAt: oldest.toISOString() },
    });
    expect(settings.get).toHaveBeenCalledWith('co-1');
    expect(approvals.overdueIn).toHaveBeenCalledWith(
      { kind: 'DEPTS', companyId: 'co-1', departmentIds: ['dept-1', 'dept-2'], excludeUserId: 'm1' },
      NOW,
    );
  });

  it('says "1 approval is" for one', async () => {
    const { svc } = setup({ count: 1, oldestDueAt: null });
    await expect(svc.assertCanEndDay(me('m1', Role.MANAGER), NOW)).rejects.toMatchObject({
      message: '1 approval is past 48 hours. Decide them in the portal to end your day.',
      details: { count: 1, oldestDueAt: null },
    });
  });

  it('never stops an Admin, a Super Admin or staff on approvals, nor a Manager with the setting off', async () => {
    const busy = { count: 5, oldestDueAt: new Date() };
    for (const who of [me('sa', Role.SUPER_ADMIN), me('ad', Role.ADMIN), me('u1', Role.USER)]) {
      const s = setup(busy);
      await expect(s.svc.assertCanEndDay(who, NOW)).resolves.toBeUndefined();
      expect(s.approvals.overdueIn).not.toHaveBeenCalled();
    }
    const off = setup(busy, false);
    await expect(off.svc.assertCanEndDay(me('m1', Role.MANAGER), NOW)).resolves.toBeUndefined();
    expect(off.approvals.overdueIn).not.toHaveBeenCalled();
  });

  it('a Manager outside any organisation decides nothing, so is never stopped', async () => {
    const s = setup({ count: 5, oldestDueAt: null });
    await expect(
      s.svc.assertCanEndDay(me('m1', Role.MANAGER, { companyId: null, orgId: null }), NOW),
    ).resolves.toBeUndefined();
    expect(s.approvals.overdueIn).not.toHaveBeenCalled();
  });
});

describe('WorkdayService view', () => {
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
  const shift = {
    id: 'sh-1',
    name: 'General',
    start: '09:30',
    end: '18:30',
    reasonMinChars: 12,
    workDays: [1, 2, 3, 4, 5, 6],
    breaks: [],
  };
  const plan = (over: Partial<DayPlan> = {}): DayPlan => ({
    date: '2026-10-14',
    isWorkingDay: true,
    label: null,
    shift: shift as never,
    bufferMin: 10,
    allowance: { scheduledSec: 3600, bufferSec: 600, totalSec: 4200 },
    shiftLengthSec: 9 * 3600,
    targetSec: 9 * 3600 - 4200,
    ...over,
  });
  const idle = effectiveIdle(idleFromStored({ idleDefaultEnabled: true }), null, { idleEnabled: null, idleMinutes: null });

  function setup(todayKey: string, opts: { day?: Record<string, unknown>; plan?: DayPlan; overdue?: number } = {}) {
    const sessions = {
      findOpen: jest.fn().mockResolvedValue(null),
      findLastEnded: jest.fn().mockResolvedValue(ended),
    };
    const approvals = { overdueIn: jest.fn().mockResolvedValue({ count: opts.overdue ?? 0, oldestDueAt: null }) };
    const people = {
      findById: jest.fn().mockResolvedValue({ id: 'u1', role: 'USER', companyId: 'co-1', department: 'Ops', departmentId: 'dept-1' }),
    };
    const dayData = {
      load: jest.fn(async () => ({
        day: (userId: string, date: string) => ({
          userId,
          date,
          sessions: date === ended.date ? [ended] : [],
          presence: [],
          breakRecords: [],
          meetingRecords: [],
          ...(date === ended.date ? opts.day : {}),
        }),
      })),
    };
    const days = {
      context: jest.fn().mockResolvedValue({}),
      dayWith: jest.fn().mockReturnValue({ dateKey: todayKey }),
    };
    const settings = {
      get: jest.fn().mockResolvedValue(DEFAULT_SETTINGS),
      effectiveIdleFor: jest.fn().mockResolvedValue(idle),
    };
    const plans = {
      context: jest.fn().mockResolvedValue({ plan: jest.fn((_p: unknown, date: string) => ({ ...(opts.plan ?? plan()), date })) }),
    };
    const config = { get: jest.fn((key: string) => (key === 'portalPublicUrl' ? 'https://portal.example.test' : undefined)) };
    const { svc } = build({ sessions, approvals, people, dayData, days, settings, plans, config });
    return { svc, sessions, approvals, plans, settings };
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

  it('4.0: target, allowance, calendar day, away and the agent config (SPEC 5.6)', async () => {
    // A 40 min lunch (30 min scheduled) and 20 min pending + 5 min unexplained away.
    const lunch = {
      id: 'b1',
      userId: 'u1',
      date: '2026-10-14',
      kind: 'LUNCH',
      presenceType: 'LUNCH',
      durationMin: 30,
      startedAt: ist('2026-10-14', '13:00'),
      endedAt: ist('2026-10-14', '13:40'),
      approvalStatus: 'NOT_REQUIRED',
      outcome: 'TAKEN',
    };
    const { svc, settings } = setup('2026-10-14', {
      day: {
        presence: [{ type: 'LUNCH', startedAt: lunch.startedAt, endedAt: lunch.endedAt }],
        breakRecords: [lunch],
        away: [
          { status: 'PENDING', startedAt: ist('2026-10-14', '15:00'), endedAt: ist('2026-10-14', '15:20'), seconds: 1200 },
          { status: 'UNEXPLAINED', startedAt: ist('2026-10-14', '16:00'), endedAt: ist('2026-10-14', '16:05'), seconds: 300 },
        ],
      },
    });
    const view = await svc.view(me('u1', Role.USER), ist('2026-10-14', '19:00'));
    expect(view).toMatchObject({
      state: 'ENDED',
      targetSec: 9 * 3600 - 4200,
      expectedSec: 9 * 3600 - 4200,
      isWorkingDay: true,
      dayLabel: null,
      allowance: {
        scheduledSec: 3600,
        bufferSec: 600,
        totalSec: 4200,
        paidUsedSec: 40 * 60,
        bufferUsedSec: 10 * 60,
        unpaidSec: 0,
      },
      away: { pendingSec: 20 * 60, unexplainedSec: 5 * 60 },
      config: { idle, quickBreakMinutes: [5, 10, 15], breakBufferMin: 10 },
      shift: { id: 'sh-1', name: 'General', start: '09:30', end: '18:30' },
      settings: { approvalSlaHours: 48, reasonMinChars: 12 },
      portalUrl: 'https://portal.example.test',
    });
    expect(view.focus).toMatchObject({
      focusSec: 9 * 3600 - 40 * 60 - 25 * 60,
      breakSec: 40 * 60,
      paidBreakSec: 40 * 60,
      awayPendingSec: 20 * 60,
      pendingPlusSec: 20 * 60,
    });
    expect(settings.effectiveIdleFor).toHaveBeenCalledWith('u1');
    expect(settings.get).toHaveBeenCalledWith('co-1');
  });

  it('a holiday has no target and carries its label', async () => {
    const { svc } = setup('2026-10-20', { plan: plan({ isWorkingDay: false, label: 'Diwali', targetSec: 0 }) });
    const view = await svc.view(me('u1', Role.USER), ist('2026-10-20', '11:00'));
    expect(view).toMatchObject({ isWorkingDay: false, dayLabel: 'Diwali', targetSec: 0, expectedSec: 0, lateStart: null });
  });

  it("a Manager sees their departments' overdue count and whether End Day is blocked", async () => {
    const { svc, approvals } = setup('2026-10-14', { overdue: 2 });
    const view = await svc.view(me('m1', Role.MANAGER), ist('2026-10-14', '19:00'));
    expect(view).toMatchObject({ overdueApprovals: 2, endDayBlockedByOverdue: true });
    expect(approvals.overdueIn.mock.calls[0][0]).toMatchObject({ kind: 'DEPTS', companyId: 'co-1' });
    // Staff decide nothing: no count asked for.
    const staff = setup('2026-10-14', { overdue: 2 });
    expect((await staff.svc.view(me('u1', Role.USER), ist('2026-10-14', '19:00'))).overdueApprovals).toBe(0);
    expect(staff.approvals.overdueIn).not.toHaveBeenCalled();
  });
});

describe('AppSettingsService (per organisation, 4.0)', () => {
  function store(rows: Record<string, unknown> = {}) {
    return {
      read: jest.fn(async (key: string) => rows[key] ?? null),
      write: jest.fn(async (key: string, value: unknown) => {
        rows[key] = value;
      }),
      companyOfUser: jest.fn(async () => 'co-1'),
      idleFactsOfUser: jest.fn(
        async (): Promise<{ companyId: string; departmentId: string; idleEnabled: boolean | null; idleMinutes: number | null }> => ({
          companyId: 'co-1',
          departmentId: 'dept-1',
          idleEnabled: null,
          idleMinutes: 7,
        }),
      ),
    };
  }

  it('reads defaults, caches reads, and refuses out-of-range values naming the field', async () => {
    const s = store();
    const svc = new AppSettingsService(s as never);
    expect(await svc.get('co-1')).toEqual(DEFAULT_SETTINGS);
    // Its own row, then the 3.x row as a fallback.
    expect(s.read.mock.calls.map((c) => c[0])).toEqual(['org:co-1', 'org']);
    await svc.get('co-1');
    expect(s.read).toHaveBeenCalledTimes(2);

    await expect(svc.update('co-1', { approvalSlaHours: 6 }, 'sa')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      details: { field: 'approvalSlaHours' },
    });
    await expect(svc.update('co-1', { halfDayPct: 90 }, 'sa')).rejects.toMatchObject({
      details: { field: 'halfDayPct' },
    });
    await expect(svc.update('co-1', { breakBufferMin: 61 }, 'sa')).rejects.toMatchObject({
      details: { field: 'breakBufferMin' },
    });
    expect(s.write).not.toHaveBeenCalled();

    const saved = await svc.update('co-1', { approvalSlaHours: 24, quietHoursFlag: 6, breakBufferMin: 15 }, 'sa');
    expect(saved).toMatchObject({ approvalSlaHours: 24, quietHoursFlag: 6, fullDayPct: 80, breakBufferMin: 15 });
    expect(s.write).toHaveBeenCalledWith('org:co-1', saved, 'sa');
    // The write refreshed the cache: no read needed.
    const reads = s.read.mock.calls.length;
    expect(await svc.get('co-1')).toEqual(saved);
    expect(s.read).toHaveBeenCalledTimes(reads);
  });

  it("an organisation without its own row reads the 3.x row; saving keeps the row's other keys", async () => {
    const s = store({ org: { approvalSlaHours: 72 }, 'org:co-2': { weekPattern: [1, 2, 3, 4, 5], fullDayPct: 90 } });
    const svc = new AppSettingsService(s as never);
    expect((await svc.get('co-1')).approvalSlaHours).toBe(72);
    expect((await svc.get('co-2')).fullDayPct).toBe(90);
    expect((await svc.get('co-2')).approvalSlaHours).toBe(48);
    await svc.update('co-2', { breakBufferMin: 0 }, 'admin');
    expect(s.write.mock.calls[0][0]).toBe('org:co-2');
    expect(s.write.mock.calls[0][1]).toMatchObject({ weekPattern: [1, 2, 3, 4, 5], fullDayPct: 90, breakBufferMin: 0 });
    // Organisations do not share a row.
    expect((await svc.get('co-1')).breakBufferMin).toBe(10);
  });

  it("a person's effective input tracking comes from their organisation and department", async () => {
    const s = store({ 'org:co-1': { idleDefaultEnabled: true, departmentIdle: { 'dept-1': { minutes: 12 } } } });
    const svc = new AppSettingsService(s as never);
    expect(await svc.effectiveIdleFor('u1')).toMatchObject({ enabled: true, minutes: 7 });
    s.idleFactsOfUser.mockResolvedValueOnce({ companyId: 'co-1', departmentId: 'dept-1', idleEnabled: false, idleMinutes: null });
    expect(await svc.effectiveIdleFor('u1')).toMatchObject({ enabled: false, minutes: 12 });
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
