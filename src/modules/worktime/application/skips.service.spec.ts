import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { NoticeEvent } from '@shared/events/notice.event';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { BreakRecordRow, NewBreakRecord } from '@modules/shifts/domain/break-record.repository';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { ShiftRecord } from '@modules/shifts/domain/shift.types';
import { WorkSessionRecord } from '../domain/work-session.repository';
import { SkipsService } from './skips.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

/** An IST wall time on Tue 13 Oct 2026 as an instant. */
const ist = (hm: string, day = 13) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000);
};

const general: ShiftRecord = {
  id: 'shift-general',
  companyId: 'co-1',
  isDefault: true,
  name: 'General',
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5, 6],
  ringLeadMin: 1,
  ringDurationMin: 5,
  ringSound: true,
  reasonOnEarly: true,
  reasonOnLate: true,
  reasonMinChars: 10,
  overrunReason: true,
  overrunGraceMin: 3,
  breaks: [
    {
      kind: 'MORNING',
      enabled: true,
      startTime: '11:00',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'LUNCH',
      enabled: true,
      startTime: '13:00',
      durationMin: 30,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'EVENING',
      enabled: true,
      startTime: '16:00',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
  ],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const person = (id: string, role: ShiftPerson['role'], managerId: string | null): ShiftPerson => ({
  id,
  firstName: id === 'staff' ? 'Asha' : id === 'mgr' ? 'Maya' : 'Sam',
  lastName: 'Rao',
  email: `${id}@x.test`,
  role,
  department: 'Billing',
  designation: null,
  companyId: 'co-1',
  managerId,
  active: true,
});
const people: Record<string, ShiftPerson> = {
  staff: person('staff', 'USER', 'mgr'),
  mgr: person('mgr', 'MANAGER', 'sa'),
  sa: person('sa', 'SUPER_ADMIN', null),
};

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

function row(over: Partial<BreakRecordRow>): BreakRecordRow {
  return {
    id: 'rec-1',
    userId: 'staff',
    date: '2026-10-13',
    kind: 'MORNING',
    seq: 0,
    presenceType: 'BREAK',
    shiftId: general.id,
    shiftName: 'General',
    scheduledStart: ist('11:00'),
    durationMin: 15,
    windowOpen: ist('10:30'),
    windowClose: ist('12:00'),
    ringStart: ist('10:59'),
    ringEnd: ist('11:04'),
    presenceSessionId: null,
    startedAt: ist('12:00'),
    endedAt: null,
    timing: 'OUTSIDE_WINDOW',
    minutesOff: 0,
    reason: null,
    overrunReason: null,
    source: 'SYSTEM',
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: 'mgr',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: ist('12:00'),
    outcome: 'AUTO_SKIPPED',
    overrunSec: null,
    overrunAsked: false,
    ...over,
  };
}

const workSession = (from: string, to: string | null, userId = 'staff'): WorkSessionRecord => ({
  id: `ws-${from}`,
  userId,
  date: '2026-10-13',
  startedAt: ist(from),
  endedAt: to ? ist(to) : null,
  endReason: to ? 'USER' : null,
  source: 'AGENT',
});

function setup() {
  const shiftsRepo = {
    list: jest.fn().mockResolvedValue([general]),
    listAssignmentsFor: jest.fn().mockResolvedValue([]),
    listAllAssignments: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(general),
  };
  const peopleReader = {
    findById: jest.fn(async (id: string) => people[id] ?? null),
    findAnyByIds: jest.fn(async (ids: string[]) => ids.map((id) => people[id]).filter(Boolean)),
    listSuperAdminIds: jest.fn(async () => ['sa']),
  };
  const records = {
    listForUserOnDate: jest.fn().mockResolvedValue([]),
    listForUsersOnDate: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    addComment: jest.fn(async (id: string, text: string) =>
      row({ id, reason: text, commentedAt: ist('18:00') }),
    ),
  };
  const skipsRepo = {
    createSkip: jest.fn(async (rec: NewBreakRecord, _generation: string) => ({
      ok: true,
      record: row({ ...rec, id: 'new' }),
    })),
    createAutoSkips: jest.fn(async (recs: NewBreakRecord[]) =>
      recs.map((r, i) => row({ ...r, id: `auto-${i}` })),
    ),
  };
  const sessionsRepo = {
    findOpen: jest.fn().mockResolvedValue(workSession('09:30', null)),
    listForUserOnDate: jest.fn().mockResolvedValue([]),
    dayEndedAt: jest.fn().mockResolvedValue(null),
    listUserIdsActiveOn: jest.fn().mockResolvedValue(['staff']),
    listOverlapping: jest.fn().mockResolvedValue([workSession('09:30', null)]),
  };
  const events = {
    publish: jest.fn(async (_n: string, _p: unknown) => undefined),
    subscribe: jest.fn(),
  };
  const sessions = { autoCloseIfStale: jest.fn().mockResolvedValue(false) };
  const breakEvents = { recipientsFor: jest.fn().mockResolvedValue(['mgr']) };
  const presence = { findOpen: jest.fn().mockResolvedValue(null) };
  const svc = new SkipsService(
    skipsRepo as never,
    records as never,
    peopleReader as never,
    shiftsRepo as never,
    sessionsRepo as never,
    events as never,
    new BreakDayService(shiftsRepo as never),
    sessions as never,
    breakEvents as never,
    presence as never,
  );
  const notices = () => events.publish.mock.calls.map(([, p]) => p as NoticeEvent);
  return { svc, records, skipsRepo, sessionsRepo, events, presence, breakEvents, notices };
}

const staff = me('staff', Role.USER);
const REASON = 'Client escalation call';

describe('SkipsService.skip', () => {
  it('skips an open window: SKIPPED now, timing judged, routed to the manager, manager told', async () => {
    const { svc, skipsRepo, notices } = setup();
    const res = await svc.skip(
      staff,
      { kind: 'MORNING', reason: `  ${REASON}  ` },
      'AGENT_31',
      ist('11:02'),
    );
    const written = skipsRepo.createSkip.mock.calls[0][0];
    expect(written).toMatchObject({
      kind: 'MORNING',
      outcome: 'SKIPPED',
      startedAt: ist('11:02'),
      timing: 'ON_TIME',
      minutesOff: 0,
      reason: REASON,
      source: 'AGENT',
      approvalStatus: 'PENDING',
      approverRole: 'MANAGER',
      approverId: 'mgr',
      durationMin: 15,
    });
    expect(skipsRepo.createSkip.mock.calls[0][1]).toBe('AGENT_31');
    expect(res.record.outcome).toBe('SKIPPED');
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      recipientIds: ['mgr'],
      type: 'SKIP_REQUESTED',
      fromUserId: 'staff',
    });
  });

  it('judges an early skip and sends nothing for a Super Admin (no reason needed)', async () => {
    const { svc, skipsRepo, events } = setup();
    await svc.skip(me('sa', Role.SUPER_ADMIN), { kind: 'MORNING' }, 'AGENT_31', ist('10:40'));
    expect(skipsRepo.createSkip.mock.calls[0][0]).toMatchObject({
      timing: 'EARLY',
      minutesOff: 20,
      reason: null,
      approvalStatus: 'NOT_REQUIRED',
    });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a break the shift does not have', 'MORNING', ist('11:02', 18), 'BREAK_NOT_SCHEDULED'],
    ['lunch, which cannot be skipped', 'LUNCH', ist('13:00'), 'SKIP_NOT_ALLOWED'],
    ['a window not open yet', 'EVENING', ist('11:02'), 'BREAK_NOT_OPEN'],
    ['a window that closed', 'MORNING', ist('12:01'), 'BREAK_WINDOW_CLOSED'],
  ] as const)('refuses %s', async (_label, kind, now, code) => {
    const { svc, skipsRepo } = setup();
    await expect(svc.skip(staff, { kind, reason: REASON }, 'AGENT_31', now)).rejects.toMatchObject({
      status: 409,
      code,
    });
    expect(skipsRepo.createSkip).not.toHaveBeenCalled();
  });

  it('refuses a break that has a record, or one after a later break was taken', async () => {
    const { svc, records } = setup();
    records.listForUserOnDate.mockResolvedValueOnce([row({ kind: 'MORNING', outcome: 'TAKEN' })]);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'BREAK_ALREADY_TAKEN',
    });
    records.listForUserOnDate.mockResolvedValueOnce([row({ kind: 'LUNCH', outcome: 'TAKEN' })]);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:50')),
    ).rejects.toMatchObject({
      code: 'BREAK_ORDER',
    });
  });

  it('a 3.1 agent needs an open day: DAY_NOT_STARTED, or DAY_ENDED after End Day', async () => {
    const { svc, sessionsRepo } = setup();
    sessionsRepo.findOpen.mockResolvedValue(null);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'DAY_NOT_STARTED',
    });
    sessionsRepo.listForUserOnDate.mockResolvedValue([workSession('09:30', '10:45')]);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'DAY_ENDED',
    });
  });

  it('an older agent skips without a session (one opens implicitly) unless the day was ended', async () => {
    const { svc, sessionsRepo, skipsRepo } = setup();
    sessionsRepo.findOpen.mockResolvedValue(null);
    await svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'LEGACY', ist('11:02'));
    expect(skipsRepo.createSkip.mock.calls[0][1]).toBe('LEGACY');
    sessionsRepo.dayEndedAt.mockResolvedValue(ist('10:50'));
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'LEGACY', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'DAY_ENDED',
    });
  });

  it('refuses while on a break, and asks for a reason before writing', async () => {
    const { svc, presence, skipsRepo } = setup();
    presence.findOpen.mockResolvedValueOnce({ type: 'LUNCH' });
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'ALREADY_ON_BREAK',
    });
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: ' too   short ' }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({ status: 422, code: 'REASON_REQUIRED', details: { minChars: 10 } });
    expect(skipsRepo.createSkip).not.toHaveBeenCalled();
  });

  it('turns a refusal from the transaction into the matching 409', async () => {
    const { svc, skipsRepo } = setup();
    skipsRepo.createSkip.mockResolvedValueOnce({ ok: false, code: 'DAY_ENDED' } as never);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'DAY_ENDED',
    });
    skipsRepo.createSkip.mockResolvedValueOnce({ ok: false, code: 'BREAK_ALREADY_TAKEN' } as never);
    await expect(
      svc.skip(staff, { kind: 'MORNING', reason: REASON }, 'AGENT_31', ist('11:02')),
    ).rejects.toMatchObject({
      code: 'BREAK_ALREADY_TAKEN',
    });
  });
});

describe('SkipsService.comment', () => {
  it('stores one comment on a reason-less skip and tells the approver', async () => {
    const { svc, records, notices } = setup();
    records.findById.mockResolvedValue(row({}));
    const res = await svc.comment(staff, 'rec-1', '  Was on a client call  ', ist('18:00'));
    expect(records.addComment).toHaveBeenCalledWith('rec-1', 'Was on a client call', ist('18:00'));
    expect(res.record.reason).toBe('Was on a client call');
    expect(notices()[0]).toMatchObject({
      recipientIds: ['mgr'],
      type: 'SKIP_COMMENT_ADDED',
      fromUserId: 'staff',
    });
  });

  it('a decided skip still takes its comment; the decider hears about it', async () => {
    const { svc, records, notices, breakEvents } = setup();
    records.findById.mockResolvedValue(row({ approvalStatus: 'REJECTED', decidedById: 'mgr' }));
    records.addComment.mockResolvedValueOnce(
      row({ approvalStatus: 'REJECTED', decidedById: 'mgr', reason: 'Was on a client call' }),
    );
    await svc.comment(staff, 'rec-1', 'Was on a client call', ist('18:00'));
    expect(breakEvents.recipientsFor).not.toHaveBeenCalled();
    expect(notices()[0].recipientIds).toEqual(['mgr']);
  });

  it('404 unknown, 403 not mine, 409 not needed, 422 too short', async () => {
    const { svc, records } = setup();
    await expect(
      svc.comment(staff, 'nope', 'Was on a client call', ist('18:00')),
    ).rejects.toMatchObject({ status: 404 });
    records.findById.mockResolvedValue(row({ userId: 'other' }));
    await expect(
      svc.comment(staff, 'rec-1', 'Was on a client call', ist('18:00')),
    ).rejects.toMatchObject({ status: 403 });
    records.findById.mockResolvedValue(row({ reason: 'Already said why' }));
    await expect(
      svc.comment(staff, 'rec-1', 'Was on a client call', ist('18:00')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'COMMENT_NOT_NEEDED',
    });
    records.findById.mockResolvedValue(row({ outcome: 'TAKEN' }));
    await expect(
      svc.comment(staff, 'rec-1', 'Was on a client call', ist('18:00')),
    ).rejects.toMatchObject({
      code: 'COMMENT_NOT_NEEDED',
    });
    records.findById.mockResolvedValue(row({}));
    await expect(svc.comment(staff, 'rec-1', 'short', ist('18:00'))).rejects.toMatchObject({
      status: 422,
      code: 'REASON_REQUIRED',
      details: { minChars: 10 },
    });
    records.addComment.mockResolvedValueOnce(null as never);
    await expect(
      svc.comment(staff, 'rec-1', 'Was on a client call', ist('18:00')),
    ).rejects.toMatchObject({
      code: 'COMMENT_NOT_NEEDED',
    });
  });
});

describe('SkipsService.saveEndDayComments', () => {
  it('checks every comment first: one bad comment saves none', async () => {
    const { svc, records } = setup();
    records.findById.mockImplementation(async (id: string) =>
      id === 'b2' ? row({ id, userId: 'other' }) : row({ id }),
    );
    await expect(
      svc.saveEndDayComments(
        staff,
        [
          { breakId: 'b1', comment: 'Was on a client call' },
          { breakId: 'b2', comment: 'Was on a client call' },
        ],
        ist('18:30'),
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'COMMENT_INVALID',
      details: { breakId: 'b2', problem: 'NOT_YOURS' },
    });
    expect(records.addComment).not.toHaveBeenCalled();
  });

  it.each([
    [
      'DUPLICATE',
      [
        { breakId: 'b1', comment: 'Was on a client call' },
        { breakId: 'b1', comment: 'Was on a client call' },
      ],
    ],
    ['TOO_SHORT', [{ breakId: 'b1', comment: 'short' }]],
    ['TOO_LONG', [{ breakId: 'b1', comment: 'x'.repeat(501) }]],
    ['NOT_FOUND', [{ breakId: 'missing', comment: 'Was on a client call' }]],
    ['NOT_A_SKIP', [{ breakId: 'taken', comment: 'Was on a client call' }]],
  ])('names the problem: %s', async (problem, comments) => {
    const { svc, records } = setup();
    records.findById.mockImplementation(async (id: string) =>
      id === 'missing' ? null : id === 'taken' ? row({ id, outcome: 'TAKEN' }) : row({ id }),
    );
    await expect(svc.saveEndDayComments(staff, comments, ist('18:30'))).rejects.toMatchObject({
      code: 'COMMENT_INVALID',
      details: expect.objectContaining({ problem }),
    });
  });

  it('saves each comment once and leaves a skip that already has a reason alone', async () => {
    const { svc, records } = setup();
    records.findById.mockImplementation(async (id: string) =>
      id === 'b3' ? row({ id, reason: 'Said already' }) : row({ id }),
    );
    const saved = await svc.saveEndDayComments(
      staff,
      [
        { breakId: 'b1', comment: 'Was on a client call' },
        { breakId: 'b2', comment: 'Server outage, on bridge' },
        { breakId: 'b3', comment: 'anything' },
      ],
      ist('18:30'),
    );
    expect(saved).toBe(2);
    expect(records.addComment.mock.calls.map((c) => c[0])).toEqual(['b1', 'b2']);
  });
});

describe('SkipsService auto-skip', () => {
  it('an owed break whose window closed becomes AUTO_SKIPPED at the window close', async () => {
    const { svc, skipsRepo, notices } = setup();
    const n = await svc.autoSkipFor('staff', ist('12:05'), false);
    expect(n).toBe(1);
    const [rec] = skipsRepo.createAutoSkips.mock.calls[0][0];
    expect(rec).toMatchObject({
      kind: 'MORNING',
      outcome: 'AUTO_SKIPPED',
      startedAt: ist('12:00'),
      timing: 'OUTSIDE_WINDOW',
      minutesOff: 0,
      reason: null,
      source: 'SYSTEM',
      approvalStatus: 'PENDING',
      approverId: 'mgr',
    });
    expect(notices()[0]).toMatchObject({ type: 'AUTO_SKIP_REQUESTED', recipientIds: ['mgr'] });
  });

  it('ending the day inside an open window auto-skips that break at now', async () => {
    const { svc, skipsRepo } = setup();
    await svc.autoSkipFor('staff', ist('11:10'), true);
    const [rec] = skipsRepo.createAutoSkips.mock.calls[0][0];
    expect(rec).toMatchObject({ kind: 'MORNING', startedAt: ist('11:10') });
  });

  it('a break is owed only when a session covered its scheduled start', async () => {
    const { svc, sessionsRepo, skipsRepo } = setup();
    sessionsRepo.listOverlapping.mockResolvedValue([workSession('11:30', null)]);
    expect(await svc.autoSkipFor('staff', ist('12:05'), false)).toBe(0);
    expect(skipsRepo.createAutoSkips).not.toHaveBeenCalled();
  });

  it('a break with a record is not owed; the job covers everyone with a session today', async () => {
    const { svc, records, skipsRepo, sessionsRepo } = setup();
    records.listForUsersOnDate.mockResolvedValue([row({ outcome: 'TAKEN' })]);
    expect(await svc.autoSkipAll(ist('12:05'))).toBe(0);
    // Yesterday too: a night shift's working day began the evening before.
    expect(sessionsRepo.listUserIdsActiveOn).toHaveBeenCalledWith(['2026-10-12', '2026-10-13']);
    records.listForUsersOnDate.mockResolvedValue([]);
    expect(await svc.autoSkipAll(ist('12:05'))).toBe(1);
    expect(skipsRepo.createAutoSkips).toHaveBeenCalledTimes(1);
  });
});
