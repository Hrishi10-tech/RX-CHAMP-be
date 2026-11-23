import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { DEFAULT_SETTINGS } from '@modules/settings/domain/settings.rules';
import { DayDataService } from '@modules/worktime/application/day-data.service';
import {
  BiometricStretchLite,
  IntegrationPeriodLite,
} from '@modules/worktime/domain/integration-periods.reader';
import { PersonRow } from '@modules/worktime/domain/worktime.reader';
import { WorkSessionRecord } from '@modules/worktime/domain/work-session.repository';
import { emptyTotals, monthTotals } from '../domain/report-builder';
import { inPayroll } from '../domain/payroll-pause';
import { MonthSnapshot, PersonDaySummary, PersonMonthReport } from '../domain/report.types';
import { runSummary } from './report-runs.service';
import { ReportsService } from './reports.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const H = 3600;
const NOW = new Date('2026-11-05T12:00:00+05:30');
/** 4.0: organisations; the report reads each one's own integration switch. */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
/** The organisation's admin (4.0: whole organisation, every grant). */
const sa = {
  id: 'admin',
  role: Role.ADMIN,
  companyId: ORG,
  orgId: ORG,
  managedDepartmentIds: [],
} as unknown as AuthenticatedUser;
const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`);

function person(id: string, over: Partial<PersonRow> = {}): PersonRow {
  return {
    id,
    firstName: id,
    lastName: 'Test',
    email: `${id}@x.test`,
    role: 'USER',
    department: null,
    designation: null,
    companyId: ORG,
    departmentId: null,
    managerId: null,
    managerName: null,
    active: true,
    joinedOn: '2026-01-01',
    attendanceSource: 'AGENT',
    attendanceSourceFrom: null,
    ...over,
  };
}

function session(
  userId: string,
  date: string,
  from: string,
  to: string,
  source: string,
): WorkSessionRecord {
  return {
    id: `${userId}-${date}-${from}`,
    userId,
    date,
    startedAt: ist(date, from),
    endedAt: ist(date, to),
    endReason: 'USER',
    source,
  } as WorkSessionRecord;
}

/** Sunday is off; every other day is a working day of 8 hours with no shift (4.0 day plan). */
const sunday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
const plans = {
  context: jest.fn().mockResolvedValue({
    settingsOf: () => DEFAULT_SETTINGS,
    plan: (_p: unknown, date: string) => ({
      date,
      shift: null,
      isWorkingDay: !sunday(date),
      label: null,
      targetSec: sunday(date) ? 0 : 8 * H,
      bufferMin: 10,
      allowance: { scheduledSec: 0, bufferSec: 600, totalSec: 600 },
      shiftLengthSec: 0,
    }),
  }),
};

/** The real service and the real day data over fake stores. */
function setup(opts: {
  people: PersonRow[];
  sessions?: WorkSessionRecord[];
  /** The organisation's periods; by default ORG's (4.0: per organisation). */
  periods?: IntegrationPeriodLite[];
  periodsByOrg?: Record<string, IntegrationPeriodLite[]>;
  stretches?: Record<string, BiometricStretchLite[]>;
  snapshot?: MonthSnapshot | null;
  samples?: Map<
    string,
    { active: { start: number; end: number }[]; idle: { start: number; end: number }[] }
  >;
}) {
  const sessions = opts.sessions ?? [];
  const list = (ids: string[], from: string, to: string) =>
    sessions.filter((s) => ids.includes(s.userId) && s.date >= from && s.date <= to);
  const reader = {
    presenceOverlapping: jest.fn().mockResolvedValue([]),
    activityCoverage: jest.fn().mockResolvedValue([]),
    sessionDays: jest.fn(async (ids: string[], from: string, to: string) => {
      const seen = new Set(list(ids, from, to).map((s) => `${s.userId}|${s.date}`));
      return [...seen].map((k) => {
        const [userId, date] = k.split('|');
        return { userId, date, settled: false };
      });
    }),
    activeSecByHour: jest.fn().mockResolvedValue([]),
    inputOfDays: jest.fn().mockResolvedValue(opts.samples ?? new Map()),
    earliestSessionDate: jest.fn().mockResolvedValue('2026-01-01'),
    listPeople: jest.fn(async ({ ids }: { ids: string[] }) =>
      opts.people.filter((p) => ids.includes(p.id)),
    ),
  };
  const none = {
    listForUsersBetween: jest.fn().mockResolvedValue([]),
    listForUsers: jest.fn().mockResolvedValue([]),
  };
  const dayData = new DayDataService(
    { listForUsersBetween: jest.fn(async (i, f, t) => list(i, f, t)) } as never,
    none as never,
    none as never,
    none as never,
    reader as never,
    { heal: jest.fn() } as never,
    { subscribe: jest.fn(), publish: jest.fn() } as never,
    none as never,
  );
  const store = { findSnapshot: jest.fn().mockResolvedValue(opts.snapshot ?? null) };
  const scope = {
    scope: jest.fn().mockResolvedValue(opts.people),
    person: jest.fn(async (_me: unknown, id: string) => opts.people.find((p) => p.id === id)),
  };
  const byOrg = opts.periodsByOrg ?? { [ORG]: opts.periods ?? [] };
  const integration = {
    list: jest.fn(
      async (companyIds: string[]) =>
        new Map(
          Object.entries(byOrg).filter(([org, rows]) => companyIds.includes(org) && rows.length),
        ),
    ),
    biometricStretches: jest.fn(async () => new Map(Object.entries(opts.stretches ?? {}))),
  };
  const svc = new ReportsService(
    store as never,
    reader as never,
    { pendingByUserDate: jest.fn().mockResolvedValue([]) } as never,
    scope as never,
    dayData,
    { itemsFor: jest.fn().mockResolvedValue([]) } as never,
    { names: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    {} as never,
    plans as never,
    {} as never,
    { views: jest.fn().mockResolvedValue([]) } as never,
    { punchesOf: jest.fn().mockResolvedValue(new Map()) } as never,
    integration as never,
  );
  return { svc, store, integration, reader };
}

const dayOf = (m: PersonMonthReport, date: string): PersonDaySummary =>
  m.days.find((d) => d.date === date) as PersonDaySummary;

describe('the payroll pause, through the report (brief 1.6)', () => {
  const bala = person('bala', {
    attendanceSource: 'BIOMETRIC',
    attendanceSourceFrom: '2026-10-01',
  });
  const punches = session('bala', '2026-10-20', '09:30', '18:30', 'BIOMETRIC');

  it('biometric staff with the integration off: flagged, no paid time, tracked as ever', async () => {
    const { svc } = setup({ people: [bala], sessions: [punches] });
    const { persons } = await svc.buildMonth([bala], '2026-10', 'ALL', NOW);
    const d = dayOf(persons[0], '2026-10-20');
    expect(d.payrollPaused).toBe(true);
    expect(d).toMatchObject({ paidSec: 0, paidBreakSec: 0 });
    expect(d.focusSec).toBe(9 * H);
    expect(persons[0].payroll?.paused).toBe(true);
  });

  it('the integration on that day: calculated, no flag', async () => {
    const { svc } = setup({
      people: [bala],
      sessions: [punches],
      periods: [{ fromDate: '2026-10-20', toDate: '2026-10-20' }],
    });
    const { persons } = await svc.buildMonth([bala], '2026-10', 'ALL', NOW);
    const d = dayOf(persons[0], '2026-10-20');
    expect(d).not.toHaveProperty('payrollPaused');
    expect(d.paidSec).toBe(9 * H);
    expect(dayOf(persons[0], '2026-10-21').payrollPaused).toBe(true);
  });

  it('agent staff: never flagged, whatever the switch says', async () => {
    const asha = person('asha');
    const { svc } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
    });
    const { persons } = await svc.buildMonth([asha], '2026-10', 'ALL', NOW);
    expect(persons[0]).not.toHaveProperty('payroll');
    expect(persons[0].days.every((d) => !('payrollPaused' in d))).toBe(true);
    expect(dayOf(persons[0], '2026-10-20').paidSec).toBe(9 * H);
  });

  it('every one-day read asks the same question', async () => {
    const { svc } = setup({ people: [bala], sessions: [punches] });
    const one = await svc.personDay(sa, 'bala', '2026-10-20', NOW);
    expect(one.summary.payrollPaused).toBe(true);
    const team = await svc.teamDay(sa, '2026-10-20', undefined, NOW);
    expect(team.rows[0].summary.payrollPaused).toBe(true);
    const own = await svc.myDay(
      { id: 'bala', role: Role.USER, companyId: ORG, orgId: ORG } as unknown as AuthenticatedUser,
      '2026-10-20',
      NOW,
    );
    expect(own.summary.payrollPaused).toBe(true);
  });
});

describe('moving someone back to the agent recalculates nothing before the move', () => {
  // On biometric all of October, the integration never on; he punched on the 20th only. Moved
  // back on 5 November, so October's other days hold no session at all.
  const bala = person('bala', { attendanceSource: 'AGENT', attendanceSourceFrom: '2026-11-05' });
  const stretches = { bala: [{ fromDate: '2026-10-01', toDate: '2026-11-04' }] };
  const punches = session('bala', '2026-10-20', '09:30', '18:30', 'BIOMETRIC');

  it('October stays paused, off payroll, with no absences', async () => {
    const { svc } = setup({ people: [bala], sessions: [punches], stretches });
    const { persons, team } = await svc.buildMonth([bala], '2026-10', 'ALL', NOW);
    const m = persons[0];
    expect(m.payroll).toMatchObject({ paused: true, pausedFrom: '2026-10-01', pausedDays: 27 });
    expect(dayOf(m, '2026-10-21').payrollPaused).toBe(true);
    expect(inPayroll(persons)).toEqual([]);
    expect(team.totals).toMatchObject({ people: 0, absent: 0, focusSec: 0 });
    expect(runSummary(persons)).toMatchObject({ people: 0, absent: 0, payrollPaused: 1 });
  });

  it('this month: the days before the move stay paused, the days from it on are his', async () => {
    const { svc } = setup({ people: [bala], stretches });
    const { persons } = await svc.buildMonth([bala], '2026-11', 'ALL', NOW);
    const m = persons[0];
    expect(dayOf(m, '2026-11-04').payrollPaused).toBe(true);
    expect(dayOf(m, '2026-11-05')).not.toHaveProperty('payrollPaused');
    expect(m.payroll).toMatchObject({ paused: false, pausedTo: '2026-11-04' });
  });

  it('the stretches are read once, for everyone in the report', async () => {
    const { svc, integration } = setup({ people: [bala], stretches });
    await svc.buildMonth([bala], '2026-10', 'ALL', NOW);
    expect(integration.biometricStretches).toHaveBeenCalledTimes(1);
    expect(integration.biometricStretches).toHaveBeenCalledWith(['bala']);
  });

  it('the day of the move: a punch and then a day on the agent is calculated', async () => {
    const devi = person('devi', { attendanceSource: 'AGENT', attendanceSourceFrom: '2026-11-03' });
    const { svc } = setup({
      people: [devi],
      sessions: [
        session('devi', '2026-11-03', '09:00', '09:00', 'BIOMETRIC'),
        session('devi', '2026-11-03', '09:05', '18:05', 'AGENT'),
      ],
    });
    const { persons } = await svc.buildMonth([devi], '2026-11', 'ALL', NOW);
    const d = dayOf(persons[0], '2026-11-03');
    expect(d).not.toHaveProperty('payrollPaused');
    expect(d.paidSec).toBe(9 * H);
  });
});

describe('team month: payroll totals and tracked totals (brief 1.6)', () => {
  const asha = person('asha');
  const bala = person('bala', {
    attendanceSource: 'BIOMETRIC',
    attendanceSourceFrom: '2026-10-01',
  });
  const sessions = [
    session('asha', '2026-10-20', '09:30', '18:30', 'AGENT'),
    session('bala', '2026-10-20', '09:30', '18:30', 'BIOMETRIC'),
    session('bala', '2026-10-21', '09:30', '18:30', 'BIOMETRIC'),
  ];

  it('payroll leaves the paused out; the tracked totals are everyone in the rows', async () => {
    const { svc } = setup({ people: [asha, bala], sessions });
    const { team } = await svc.buildMonth([asha, bala], '2026-10', 'ALL', NOW);
    expect(team.totals).toMatchObject({ people: 1, focusSec: 9 * H });
    expect(team.trackedTotals).toMatchObject({ people: 2, focusSec: 27 * H });
    expect(team.trackedTotals.absent).toBeGreaterThan(team.totals.absent);
    const rowsSum = team.rows.reduce((s, r) => s + r.totals.absent, 0);
    expect(team.trackedTotals.absent).toBe(rowsSum);
  });

  it('a locked month reads the same way', async () => {
    const { svc } = setup({ people: [asha, bala], sessions });
    const built = await svc.buildMonth([asha, bala], '2026-10', 'ALL', NOW);
    const snapshot: MonthSnapshot = {
      version: 1,
      generatedAt: NOW.toISOString(),
      team: { ...built.team, locked: true },
      persons: { asha: built.persons[0] },
      payrollPaused: { bala: built.persons[1] },
    };
    const locked = setup({ people: [asha, bala], snapshot });
    const team = await locked.svc.teamMonth(sa, '2026-10', undefined, undefined, NOW);
    expect(team.totals).toMatchObject({ people: 1, focusSec: 9 * H });
    expect(team.trackedTotals).toMatchObject({ people: 2, focusSec: 27 * H });
  });
});

describe('month idle, by the day rule (3.6)', () => {
  const asha = person('asha');
  const bala = person('bala', {
    attendanceSource: 'BIOMETRIC',
    attendanceSourceFrom: '2026-10-21',
  });
  const inputOf = (date: string, idleMin: number) => ({
    active: [{ start: ist(date, '09:30').getTime(), end: ist(date, '12:00').getTime() }],
    idle: [
      {
        start: ist(date, '12:00').getTime(),
        end: ist(date, '12:00').getTime() + idleMin * 60_000,
      },
    ],
  });

  it('a person: the sum of the days an agent reported on', async () => {
    // Moved to biometric on the 21st: an agent day with 30 minutes idle, a day of punches.
    const { svc } = setup({
      people: [bala],
      sessions: [
        session('bala', '2026-10-20', '09:30', '18:30', 'AGENT'),
        session('bala', '2026-10-21', '09:30', '18:30', 'BIOMETRIC'),
      ],
      samples: new Map([['bala|2026-10-20', inputOf('2026-10-20', 30)]]),
    });
    const { persons } = await svc.buildMonth([bala], '2026-10', 'ALL', NOW);
    expect(dayOf(persons[0], '2026-10-20').idleSec).toBe(1800);
    expect(dayOf(persons[0], '2026-10-21').idleSec).toBeNull();
    expect(dayOf(persons[0], '2026-10-22')).not.toHaveProperty('idleSec');
    expect(persons[0].totals.idleSec).toBe(1800);
  });

  it('nobody reported at all: no figure, for the person and for the team', async () => {
    const { svc } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
    });
    const { persons, team } = await svc.buildMonth([asha], '2026-10', 'ALL', NOW);
    expect(persons[0].totals.idleSec).toBeNull();
    expect(team.totals.idleSec).toBeNull();
    expect(team.trackedTotals.idleSec).toBeNull();
  });

  it('a read that fails leaves no figure and the report still answers', async () => {
    const { svc, reader } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
    });
    reader.inputOfDays.mockRejectedValueOnce(new Error('db down'));
    const { persons } = await svc.buildMonth([asha], '2026-10', 'ALL', NOW);
    expect(dayOf(persons[0], '2026-10-20').idleSec).toBeNull();
    expect(persons[0].totals.focusSec).toBe(9 * H);
  });

  it('staff never see it on their own month', async () => {
    const { svc } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
      samples: new Map([['asha|2026-10-20', inputOf('2026-10-20', 30)]]),
    });
    const own = await svc.myMonth(
      { id: 'asha', role: Role.USER, companyId: ORG, orgId: ORG } as unknown as AuthenticatedUser,
      '2026-10',
      NOW,
    );
    expect(own.totals).not.toHaveProperty('idleSec');
    expect(own.days.every((d) => !('idleSec' in d))).toBe(true);
  });

  it('the team day: no agent reads as no figure, an agent reads as its figure', async () => {
    const { svc } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
    });
    const team = await svc.teamDay(sa, '2026-10-20', undefined, NOW);
    // DayDataService was built with no samples reader here: nothing to read, so no figure.
    expect(team.rows[0].summary.idleSec).toBeNull();
  });
});

describe('a month locked before 3.6: meeting and break time read from its days', () => {
  // As 3.5 stored them: the days carry both figures, the totals neither.
  const oldDay = (date: string, meetingSec: number, breakSec: number): PersonDaySummary =>
    ({
      date,
      weekday: 1,
      workday: true,
      dayClass: 'FULL',
      startedAt: `${date}T04:00:00.000Z`,
      endedAt: `${date}T13:00:00.000Z`,
      autoClosed: false,
      lateStart: null,
      focusSec: 8 * H,
      expectedSec: 8 * H,
      breakSec,
      meetingSec,
      approvedPlusSec: 0,
      rejectedMinusSec: 0,
      pendingPlusSec: 0,
      pendingMinusSec: 0,
      breaksTaken: 0,
      skipped: 0,
      autoSkipped: 0,
      overruns: 0,
      meetings: 1,
      pending: 0,
      quietHours: 0,
      activeMin: 0,
      availableSec: 6 * H,
    }) as PersonDaySummary;
  const days = [oldDay('2026-09-01', 2 * H, H), oldDay('2026-09-02', 2 * H, H)];
  const oldTotals = () => {
    const t: Partial<ReturnType<typeof monthTotals>> = monthTotals(days, '2026-09-30', 4);
    delete t.meetingSec;
    delete t.breakSec;
    delete t.idleSec;
    return t as ReturnType<typeof monthTotals>;
  };
  const asha = person('asha');
  const snapshot: MonthSnapshot = {
    version: 1,
    generatedAt: '2026-10-01T04:00:00.000Z',
    team: {
      month: '2026-09',
      scope: 'ALL',
      locked: true,
      generatedAt: '2026-10-01T04:00:00.000Z',
      totals: { ...emptyTotals(), people: 1 },
      trackedTotals: { ...emptyTotals(), people: 1 },
      rows: [],
    },
    persons: {
      asha: {
        person: {
          id: 'asha',
          name: 'asha Test',
          email: 'asha@x.test',
          role: 'USER',
          department: null,
          designation: null,
          managerId: null,
          managerName: null,
        },
        month: '2026-09',
        locked: true,
        generatedAt: '2026-10-01T04:00:00.000Z',
        totals: oldTotals(),
        days,
        heatmap: [],
      },
    },
  };

  it('the person month', async () => {
    const { svc } = setup({ people: [asha], snapshot });
    const m = await svc.personMonth(sa, 'asha', '2026-09', NOW);
    expect(m.locked).toBe(true);
    expect(m.totals).toMatchObject({ meetingSec: 4 * H, breakSec: 2 * H, availableSec: 12 * H });
  });

  it('the team month: its rows and both sets of totals', async () => {
    const { svc } = setup({ people: [asha], snapshot });
    const team = await svc.teamMonth(sa, '2026-09', undefined, undefined, NOW);
    expect(team.rows[0].totals).toMatchObject({ meetingSec: 4 * H, breakSec: 2 * H });
    expect(team.totals).toMatchObject({ meetingSec: 4 * H, breakSec: 2 * H });
    expect(team.trackedTotals).toMatchObject({ meetingSec: 4 * H, breakSec: 2 * H });
    // Idle was not kept then: no figure, rather than a zero.
    expect(team.trackedTotals.idleSec).toBeNull();
    expect(team.rows[0].totals).not.toHaveProperty('idleSec');
  });

  it('the person’s own month', async () => {
    const { svc } = setup({ people: [asha], snapshot });
    const own = await svc.myMonth(
      { id: 'asha', role: Role.USER, companyId: ORG, orgId: ORG } as unknown as AuthenticatedUser,
      '2026-09',
      NOW,
    );
    expect(own.totals).toMatchObject({ meetingSec: 4 * H, breakSec: 2 * H });
  });
});

describe('the payroll pause is per organisation (4.0)', () => {
  // Two organisations, each with a biometric person who punched on the 20th. Only the
  // second organisation's admin switched its integration on.
  const bala = person('bala', {
    attendanceSource: 'BIOMETRIC',
    attendanceSourceFrom: '2026-10-01',
  });
  const chitra = person('chitra', {
    companyId: OTHER_ORG,
    attendanceSource: 'BIOMETRIC',
    attendanceSourceFrom: '2026-10-01',
  });
  const sessions = [
    session('bala', '2026-10-20', '09:30', '18:30', 'BIOMETRIC'),
    session('chitra', '2026-10-20', '09:30', '18:30', 'BIOMETRIC'),
  ];
  const periodsByOrg = { [OTHER_ORG]: [{ fromDate: '2026-10-01', toDate: null }] };

  it("another organisation's switch never calculates someone: each reads its own", async () => {
    const { svc, integration } = setup({ people: [bala, chitra], sessions, periodsByOrg });
    const { persons } = await svc.buildMonth([bala, chitra], '2026-10', 'ALL', NOW);
    const [b, c] = persons;
    expect(dayOf(b, '2026-10-20').payrollPaused).toBe(true);
    expect(b.payroll?.paused).toBe(true);
    expect(dayOf(c, '2026-10-20')).not.toHaveProperty('payrollPaused');
    expect(c).not.toHaveProperty('payroll');
    // One read of the switches, for the organisations of the people in the report.
    expect(integration.list).toHaveBeenCalledTimes(1);
    expect([...integration.list.mock.calls[0][0]].sort()).toEqual([ORG, OTHER_ORG].sort());
  });

  it('an organisation that never switched it on: its biometric staff stay paused', async () => {
    const { svc } = setup({ people: [bala], sessions, periodsByOrg });
    const one = await svc.personDay(sa, 'bala', '2026-10-20', NOW);
    expect(one.summary.payrollPaused).toBe(true);
  });

  it('agent staff of an organisation with the switch off are never touched', async () => {
    const asha = person('asha');
    const { svc } = setup({
      people: [asha],
      sessions: [session('asha', '2026-10-20', '09:30', '18:30', 'AGENT')],
    });
    const { persons, team } = await svc.buildMonth([asha], '2026-10', 'ALL', NOW);
    expect(persons[0]).not.toHaveProperty('payroll');
    expect(team.totals).toEqual(team.trackedTotals);
  });
});
