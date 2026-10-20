import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { NoticeEvent } from '@shared/events/notice.event';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { BreakRecordRow } from '@modules/shifts/domain/break-record.repository';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { AwayRow } from '../domain/away.repository';
import { MeetingRecordRow } from '../domain/meeting-record.repository';
import { ApprovalsService } from './approvals.service';

const ist = (hm: string, day = 14) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000);
};
const NOW = ist('15:00');
const HOUR = 3600_000;
const ORG = 'co-1';

const person = (
  id: string,
  role: ShiftPerson['role'],
  first: string,
  over: Partial<ShiftPerson> = {},
): ShiftPerson => ({
  id,
  firstName: first,
  lastName: 'Test',
  email: `${id}@x.test`,
  role,
  department: 'Billing',
  designation: null,
  companyId: ORG,
  departmentId: 'dept-billing',
  managerId: null,
  active: true,
  ...over,
});
const people: Record<string, ShiftPerson> = {
  staff: person('staff', 'USER', 'Asha'),
  other: person('other', 'USER', 'Ravi', { departmentId: 'dept-sales', department: 'Sales' }),
  staffB: person('staffB', 'USER', 'Bea', { companyId: 'co-2' }),
  mgr: person('mgr', 'MANAGER', 'Maya'),
  mgr2: person('mgr2', 'MANAGER', 'Arjun', { departmentId: 'dept-sales' }),
  admin: person('admin', 'ADMIN', 'Ada', { departmentId: null, department: null }),
  sa: person('sa', 'SUPER_ADMIN', 'Sam', { companyId: null, departmentId: null, department: null }),
};

const me = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id,
    email: `${id}@x.test`,
    role,
    permissions: [],
    department: null,
    companyId: role === Role.SUPER_ADMIN ? null : ORG,
    status: 'ACTIVE',
    orgId: ORG,
    departmentId: people[id]?.departmentId ?? null,
    managedDepartmentIds: id === 'mgr' ? ['dept-billing'] : id === 'mgr2' ? ['dept-sales'] : [],
    ...over,
  }) as AuthenticatedUser;
const MGR = me('mgr', Role.MANAGER);
const ADMIN = me('admin', Role.ADMIN);
const SA = me('sa', Role.SUPER_ADMIN);

function meeting(over: Partial<MeetingRecordRow> = {}): MeetingRecordRow {
  return {
    id: 'm1',
    userId: 'staff',
    date: '2026-10-14',
    mode: 'PAST',
    agenda: 'Client call',
    participants: [{ name: 'Ravi' }],
    startedAt: ist('10:00'),
    endedAt: ist('10:45'),
    durationSec: 45 * 60,
    presenceSessionId: null,
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    dueAt: new Date(ist('10:45').getTime() + 48 * HOUR),
    escalatedAt: null,
    remindedAt: null,
    createdAt: ist('10:45'),
    ...over,
  };
}

function skip(over: Partial<BreakRecordRow> = {}): BreakRecordRow {
  return {
    id: 'b1',
    userId: 'staff',
    date: '2026-10-14',
    kind: 'MORNING',
    seq: 0,
    presenceType: 'BREAK',
    shiftId: 'sh1',
    shiftName: 'General',
    scheduledStart: ist('11:00'),
    durationMin: 15,
    windowOpen: ist('10:30'),
    windowClose: ist('12:00'),
    ringStart: ist('10:59'),
    ringEnd: ist('11:04'),
    presenceSessionId: null,
    startedAt: ist('11:02'),
    endedAt: null,
    timing: 'ON_TIME',
    minutesOff: 0,
    reason: 'Client escalation call',
    overrunReason: null,
    source: 'AGENT',
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: ist('11:02'),
    outcome: 'SKIPPED',
    overrunSec: null,
    overrunAsked: false,
    dueAt: new Date(ist('11:02').getTime() + 48 * HOUR),
    escalatedAt: null,
    remindedAt: null,
    ...over,
  };
}

function away(over: Partial<AwayRow> = {}): AwayRow {
  return {
    id: 'a1',
    userId: 'staff',
    companyId: ORG,
    date: '2026-10-14',
    startedAt: ist('14:05'),
    endedAt: ist('14:30'),
    seconds: 25 * 60,
    reasonKey: 'MEETING',
    reasonKind: 'MEETING',
    reasonLabel: 'Short meeting',
    comment: 'Hallway sync on the release',
    participants: [{ name: 'Ravi' }, { id: 'mgr', name: 'Maya' }],
    momSender: 'Asha',
    status: 'PENDING',
    approverRole: 'MANAGER',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    dueAt: new Date(ist('14:30').getTime() + 48 * HOUR),
    escalatedAt: null,
    remindedAt: null,
    createdAt: ist('14:30'),
    ...over,
  };
}

type Decision = { status: string; decidedById: string | null; decidedAt: Date | null; note: string | null; dueAt?: Date | null };

function setup() {
  const reader = {
    list: jest.fn().mockResolvedValue({ total: 0, refs: [] }),
    count: jest.fn().mockResolvedValue(0),
    countDecidedBetween: jest.fn().mockResolvedValue(0),
    lockedMonths: jest.fn().mockResolvedValue(new Set()),
  };
  const breaks = { listByIds: jest.fn().mockResolvedValue([]) };
  const meetings = {
    findById: jest.fn().mockResolvedValue(meeting()),
    listByIds: jest.fn().mockResolvedValue([]),
    decide: jest.fn(async (_id: string, _expected: string[], d: Decision) =>
      meeting({
        approvalStatus: d.status as MeetingRecordRow['approvalStatus'],
        decidedById: d.decidedById,
        decidedAt: d.decidedAt,
        decisionNote: d.note,
      }),
    ),
  };
  const awayRepo = {
    findById: jest.fn().mockResolvedValue(away()),
    listByIds: jest.fn().mockResolvedValue([]),
    decide: jest.fn(async (_id: string, _expected: string[], d: Decision) =>
      away({
        status: d.status as AwayRow['status'],
        decidedById: d.decidedById,
        decidedAt: d.decidedAt,
        decisionNote: d.note,
        ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}),
      }),
    ),
  };
  const peopleReader = {
    findById: jest.fn(async (id: string) => people[id] ?? null),
    findAnyByIds: jest.fn(async (ids: string[]) => ids.map((id) => people[id]).filter(Boolean)),
  };
  const events = {
    publish: jest.fn(async (_n: string, _p: unknown) => undefined),
    subscribe: jest.fn(),
  };
  const breakApprovals = {
    decideRecord: jest.fn(async (_me: unknown, _id: string, status: string, note: string | null) =>
      skip({
        approvalStatus: status as BreakRecordRow['approvalStatus'],
        decidedById: 'mgr',
        decidedAt: NOW,
        decisionNote: note,
      }),
    ),
    reopenRecord: jest.fn(async () => skip()),
  };
  const meetingService = { heal: jest.fn().mockResolvedValue(undefined) };
  const settings = {
    get: jest.fn().mockResolvedValue({ approvalSlaHours: 48 }),
    forUser: jest.fn().mockResolvedValue({ approvalSlaHours: 24 }),
  };
  const svc = new ApprovalsService(
    reader as never,
    breaks as never,
    meetings as never,
    awayRepo as never,
    peopleReader as never,
    events as never,
    breakApprovals as never,
    meetingService as never,
    settings as never,
  );
  const notices = () =>
    events.publish.mock.calls.filter(([n]) => n === NoticeEvent.eventName).map(([, p]) => p as NoticeEvent);
  const pushes = () =>
    events.publish.mock.calls
      .filter(([n]) => n === WorkdayChangedEvent.eventName)
      .map(([, p]) => p as WorkdayChangedEvent);
  return { svc, reader, breaks, meetings, awayRepo, breakApprovals, meetingService, settings, notices, pushes };
}

describe('ApprovalsService deciding meetings', () => {
  it('approves: counted as focus time, the person hears who decided, and their agent re-reads the day', async () => {
    const { svc, meetings, notices, pushes } = setup();
    const item = await svc.approve(MGR, 'meeting', 'm1', '  thanks ', NOW);
    expect(meetings.decide).toHaveBeenCalledWith('m1', ['PENDING'], {
      status: 'APPROVED',
      decidedById: 'mgr',
      decidedAt: NOW,
      note: 'thanks',
    });
    expect(item).toMatchObject({
      type: 'MEETING',
      category: 'MEETING_PAST',
      status: 'APPROVED',
      effect: { mode: 'NONE', text: 'Counted as focus time' },
      decidedById: 'mgr',
      decidedByName: 'Maya Test',
      canDecide: true,
    });
    expect(notices()[0]).toMatchObject({
      recipientIds: ['staff'],
      type: 'MEETING_DECIDED',
      title: 'Your meeting on 14 Oct was approved',
      body: 'Maya Test: thanks',
      fromUserId: 'mgr',
    });
    expect(pushes()).toEqual([expect.objectContaining({ userIds: ['staff'], reason: 'DECISION' })]);
  });

  it('rejects only with a note of 3 characters or more; the minutes come off', async () => {
    const { svc, meetings } = setup();
    await expect(svc.reject(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'NOTE_REQUIRED',
    });
    await expect(svc.reject(MGR, 'meeting', 'm1', ' no ', NOW)).rejects.toMatchObject({
      code: 'NOTE_REQUIRED',
    });
    expect(meetings.decide).not.toHaveBeenCalled();
    const item = await svc.reject(MGR, 'meeting', 'm1', 'Not a work meeting', NOW);
    expect(item.effect).toEqual({ mode: 'MINUS', minutes: 45, text: '−45 min taken off' });
  });

  it('nobody decides their own (403); a Manager of another department does not even see it (404); staff are kept out (403)', async () => {
    const { svc, meetings } = setup();
    meetings.findById.mockResolvedValue(meeting({ userId: 'mgr', approverRole: 'ADMIN' }));
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({ status: 403 });
    meetings.findById.mockResolvedValue(meeting({ userId: 'admin', approverRole: null, approvalStatus: 'NOT_REQUIRED' }));
    await expect(svc.approve(ADMIN, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({ status: 403 });

    meetings.findById.mockResolvedValue(meeting());
    await expect(svc.approve(me('mgr2', Role.MANAGER), 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.approve(me('staff2', Role.USER), 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 403,
    });
    expect(meetings.decide).not.toHaveBeenCalled();
  });

  it("the Admin and a Super Admin decide anyone's in the organisation; a manager's goes to them", async () => {
    const { svc, meetings } = setup();
    await expect(svc.approve(ADMIN, 'meeting', 'm1', undefined, NOW)).resolves.toMatchObject({ status: 'APPROVED' });
    await expect(svc.approve(SA, 'meeting', 'm1', undefined, NOW)).resolves.toMatchObject({ status: 'APPROVED' });
    meetings.findById.mockResolvedValue(meeting({ userId: 'mgr', approverRole: 'ADMIN' }));
    await expect(svc.approve(ADMIN, 'meeting', 'm1', undefined, NOW)).resolves.toMatchObject({ status: 'APPROVED' });
    // A manager never decides another manager's.
    await expect(svc.approve(me('mgr2', Role.MANAGER), 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('never across organisations: 404 for an item of another organisation', async () => {
    const { svc, meetings } = setup();
    meetings.findById.mockResolvedValue(meeting({ userId: 'staffB' }));
    await expect(svc.approve(ADMIN, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.approve(SA, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({ status: 404 });
    expect(meetings.decide).not.toHaveBeenCalled();
  });

  it('a Super Admin without an organisation selected is asked to choose one (400 ORG_REQUIRED)', async () => {
    const { svc } = setup();
    await expect(svc.approve(me('sa', Role.SUPER_ADMIN, { orgId: null }), 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'ORG_REQUIRED',
    });
  });

  it('a live meeting is healed first and cannot be decided while it runs', async () => {
    const { svc, meetings, meetingService } = setup();
    meetings.findById.mockResolvedValue(meeting({ mode: 'LIVE', endedAt: null, durationSec: null }));
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 409,
      code: 'MEETING_IN_PROGRESS',
    });
    expect(meetingService.heal).toHaveBeenCalledWith(['staff'], NOW);
    expect(meetings.decide).not.toHaveBeenCalled();
  });

  it('409 when already decided, needing no approval, or decided by someone else a moment ago', async () => {
    const { svc, meetings } = setup();
    meetings.findById
      .mockResolvedValueOnce(meeting({ approvalStatus: 'APPROVED' }))
      .mockResolvedValueOnce(meeting({ approvalStatus: 'APPROVED' }));
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
    });
    meetings.findById.mockResolvedValue(meeting({ approvalStatus: 'NOT_REQUIRED' }));
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      message: 'This meeting needs no approval.',
    });
    meetings.findById.mockResolvedValue(meeting());
    meetings.decide.mockResolvedValueOnce(null as never);
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
    });
  });

  it('reopens: only the decider or an Admin / Super Admin, only a decided meeting', async () => {
    const { svc, meetings } = setup();
    meetings.findById.mockResolvedValue(meeting({ approvalStatus: 'REJECTED', decidedById: 'admin' }));
    await expect(svc.reopen(MGR, 'meeting', 'm1', NOW)).rejects.toMatchObject({ status: 403 });
    const item = await svc.reopen(SA, 'meeting', 'm1', NOW);
    expect(meetings.decide).toHaveBeenCalledWith('m1', ['APPROVED', 'REJECTED'], {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    expect(item.status).toBe('PENDING');
    meetings.findById.mockResolvedValue(meeting({ approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    await expect(svc.reopen(MGR, 'meeting', 'm1', NOW)).resolves.toMatchObject({ status: 'PENDING' });
    meetings.findById.mockResolvedValue(meeting());
    await expect(svc.reopen(ADMIN, 'meeting', 'm1', NOW)).rejects.toMatchObject({
      code: 'NOT_DECIDED',
    });
  });
});

describe('ApprovalsService deciding breaks', () => {
  it('goes through the break approvals use case and returns the item', async () => {
    const { svc, breakApprovals, pushes } = setup();
    const item = await svc.reject(MGR, 'break', 'b1', 'Please take your breaks', NOW);
    expect(breakApprovals.decideRecord).toHaveBeenCalledWith(
      MGR,
      'b1',
      'REJECTED',
      'Please take your breaks',
    );
    expect(item).toMatchObject({
      type: 'BREAK',
      category: 'BREAK_SKIP',
      status: 'REJECTED',
      effect: { mode: 'MINUS', minutes: 15, text: '−15 min taken off' },
      title: 'Morning break skipped',
      detail: 'Skipped at 11:02 AM · window 10:30 AM to 12:00 PM',
    });
    expect(pushes()[0].userIds).toEqual(['staff']);
  });

  it('reopens a break through the use case', async () => {
    const { svc, breakApprovals } = setup();
    const item = await svc.reopen(ADMIN, 'break', 'b1', NOW);
    expect(breakApprovals.reopenRecord).toHaveBeenCalledWith(ADMIN, 'b1');
    expect(item.status).toBe('PENDING');
  });

  it('bulk approve skips repeats and reports what could not be approved', async () => {
    const { svc, breakApprovals, meetings, awayRepo } = setup();
    breakApprovals.decideRecord.mockRejectedValueOnce(new Error('Already approved.'));
    meetings.findById.mockResolvedValue(meeting());
    awayRepo.findById.mockResolvedValueOnce(away({ userId: 'other' }));
    const res = await svc.bulkApprove(
      MGR,
      [
        { type: 'break', id: 'b1' },
        { type: 'break', id: 'b1' },
        { type: 'break', id: 'b2' },
        { type: 'meeting', id: 'm1' },
        { type: 'away', id: 'a-other' },
        { type: 'away', id: 'a1' },
      ],
      undefined,
      NOW,
    );
    expect(res.skipped).toEqual([
      { type: 'break', id: 'b1', reason: 'Already approved.' },
      { type: 'away', id: 'a-other', reason: 'Unknown away time' },
    ]);
    expect(res.approved).toEqual([
      { type: 'break', id: 'b2' },
      { type: 'meeting', id: 'm1' },
      { type: 'away', id: 'a1' },
    ]);
    expect(breakApprovals.decideRecord).toHaveBeenCalledTimes(2);
  });
});

describe('ApprovalsService deciding away time (4.0)', () => {
  it('approves pending away time: it counts as focus, the person is told and their History refreshes', async () => {
    const { svc, awayRepo, notices, pushes } = setup();
    const item = await svc.approve(MGR, 'away', 'a1', ' ok ', NOW);
    expect(awayRepo.decide).toHaveBeenCalledWith('a1', ['PENDING'], {
      status: 'APPROVED',
      decidedById: 'mgr',
      decidedAt: NOW,
      note: 'ok',
    });
    expect(item).toMatchObject({
      type: 'AWAY',
      category: 'AWAY_MEETING',
      status: 'APPROVED',
      title: 'Away 25 min: Short meeting',
      detail: '2:05 PM to 2:30 PM · 25 min · 2 people · minutes by Asha',
      reason: 'Hallway sync on the release',
      effect: { mode: 'PLUS', minutes: 25, text: '+25 min added' },
      away: {
        reasonKey: 'MEETING',
        reasonKind: 'MEETING',
        momSender: 'Asha',
        participants: [{ name: 'Ravi' }, { id: 'mgr', name: 'Maya' }],
        seconds: 1500,
      },
      break: null,
      meeting: null,
    });
    expect(notices()[0]).toMatchObject({
      recipientIds: ['staff'],
      type: 'AWAY_DECIDED',
      title: 'Away time approved',
      body: 'Maya Test approved 25 min on 2026-10-14. It counts as focus time.',
      fromUserId: 'mgr',
    });
    expect(pushes()[0]).toMatchObject({ userIds: ['staff'], reason: 'DECISION' });
  });

  it('rejects with a note, which the person reads', async () => {
    const { svc, notices } = setup();
    const item = await svc.reject(ADMIN, 'away', 'a1', 'Please log meetings', NOW);
    expect(item).toMatchObject({ status: 'REJECTED', effect: { mode: 'NONE' } });
    expect(notices()[0]).toMatchObject({
      title: 'Away time not approved',
      body: 'Ada Test did not approve 25 min on 2026-10-14. Note: Please log meetings',
    });
  });

  it('follows the same routing: own 403, out of scope 404, already decided 409', async () => {
    const { svc, awayRepo } = setup();
    awayRepo.findById.mockResolvedValueOnce(away({ userId: 'mgr' }));
    await expect(svc.approve(MGR, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({ status: 403 });
    awayRepo.findById.mockResolvedValueOnce(away({ userId: 'other' }));
    await expect(svc.approve(MGR, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({ status: 404 });
    awayRepo.findById.mockResolvedValueOnce(away({ userId: 'staffB', companyId: 'co-2' }));
    await expect(svc.approve(ADMIN, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({ status: 404 });
    awayRepo.findById.mockResolvedValueOnce(null);
    await expect(svc.approve(ADMIN, 'away', 'nope', undefined, NOW)).rejects.toMatchObject({ status: 404 });
    awayRepo.findById.mockResolvedValueOnce(away({ status: 'APPROVED' }));
    await expect(svc.approve(MGR, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      message: 'Already approved.',
    });
    awayRepo.findById.mockResolvedValueOnce(away({ status: 'UNEXPLAINED' }));
    await expect(svc.approve(MGR, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      message: 'This needs no approval.',
    });
    awayRepo.decide.mockResolvedValueOnce(null as never);
    await expect(svc.approve(MGR, 'away', 'a1', undefined, NOW)).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
  });

  it("reopens a decided away item with a fresh due time from the person's organisation", async () => {
    const { svc, awayRepo, settings } = setup();
    awayRepo.findById.mockResolvedValue(away({ status: 'REJECTED', decidedById: 'admin' }));
    await expect(svc.reopen(MGR, 'away', 'a1', NOW)).rejects.toMatchObject({ status: 403 });
    const item = await svc.reopen(ADMIN, 'away', 'a1', NOW);
    expect(settings.forUser).toHaveBeenCalledWith('staff');
    expect(awayRepo.decide).toHaveBeenCalledWith('a1', ['APPROVED', 'REJECTED'], {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
      dueAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(item).toMatchObject({ status: 'PENDING', effect: { text: '+25 min if approved' } });
    awayRepo.findById.mockResolvedValue(away());
    await expect(svc.reopen(ADMIN, 'away', 'a1', NOW)).rejects.toMatchObject({ code: 'NOT_DECIDED' });
  });
});

describe('ApprovalsService views and lists', () => {
  it('keeps the order, drops records needing no approval, flags overdue, and locks decided months per organisation', async () => {
    const { svc, reader, breaks, meetings, awayRepo } = setup();
    breaks.listByIds.mockResolvedValue([
      skip({
        id: 'b-old',
        date: '2026-09-28',
        dueAt: ist('10:00', 13),
        escalatedAt: ist('10:15', 13),
      }),
      skip({
        id: 'b-admin',
        userId: 'admin',
        approvalStatus: 'NOT_REQUIRED',
        approverRole: null,
      }),
    ]);
    meetings.listByIds.mockResolvedValue([meeting({ dueAt: new Date(NOW.getTime() + 2 * HOUR) })]);
    awayRepo.listByIds.mockResolvedValue([
      away(),
      away({ id: 'a-unexplained', status: 'UNEXPLAINED', approverRole: null }),
      away({ id: 'a-break', status: 'NOT_REQUIRED', approverRole: null }),
    ]);
    reader.lockedMonths.mockResolvedValue(new Set([`${ORG}|2026-09`]));
    const items = await svc.views(
      MGR,
      [
        { type: 'MEETING', id: 'm1' },
        { type: 'AWAY', id: 'a-unexplained' },
        { type: 'BREAK', id: 'b-admin' },
        { type: 'AWAY', id: 'a1' },
        { type: 'BREAK', id: 'b-old' },
        { type: 'AWAY', id: 'a-break' },
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['m1', 'a1', 'b-old']);
    expect(reader.lockedMonths.mock.calls[0][0]).toEqual([ORG, ORG, ORG, ORG, ORG, ORG]);
    expect(items[0]).toMatchObject({ dueSoon: true, overdue: false, canDecide: true, locked: false });
    expect(items[1]).toMatchObject({ type: 'AWAY', canDecide: true, locked: false });
    expect(items[2]).toMatchObject({
      overdue: true,
      dueSoon: false,
      escalated: true,
      locked: true,
      canDecide: false,
    });
  });

  it('a lock of another organisation does not lock this one', async () => {
    const { svc, reader, breaks } = setup();
    breaks.listByIds.mockResolvedValue([skip({ id: 'b-old', date: '2026-09-28' })]);
    reader.lockedMonths.mockResolvedValue(new Set(['co-2|2026-09']));
    const [item] = await svc.views(ADMIN, [{ type: 'BREAK', id: 'b-old' }], NOW);
    expect(item).toMatchObject({ locked: false, canDecide: true });
  });

  it('never shows what the caller may not see, and marks what they cannot decide', async () => {
    const { svc, breaks, meetings } = setup();
    breaks.listByIds.mockResolvedValue([
      skip({ id: 'b-staff' }),
      skip({ id: 'b-other', userId: 'other' }),
      skip({ id: 'b-b', userId: 'staffB' }),
      skip({ id: 'b-mgr', userId: 'mgr', approverRole: 'ADMIN' }),
    ]);
    meetings.listByIds.mockResolvedValue([]);
    const refs = ['b-staff', 'b-other', 'b-b', 'b-mgr'].map((id) => ({ type: 'BREAK' as const, id }));
    expect((await svc.views(MGR, refs, NOW)).map((i) => [i.id, i.canDecide])).toEqual([
      ['b-staff', true],
      ['b-mgr', false],
    ]);
    expect((await svc.views(ADMIN, refs, NOW)).map((i) => [i.id, i.canDecide])).toEqual([
      ['b-staff', true],
      ['b-other', true],
      ['b-mgr', true],
    ]);
  });

  it('lists by organisation and department scope; overdue means pending past due', async () => {
    const { svc, reader } = setup();
    await svc.list(MGR, { scope: 'all' }, NOW);
    expect(reader.list.mock.calls[0][0]).toMatchObject({
      scope: { kind: 'DEPTS', companyId: ORG, departmentIds: ['dept-billing'], excludeUserId: 'mgr' },
      statuses: ['PENDING'],
      skip: 0,
      take: 50,
    });
    await svc.list(SA, { scope: 'all', status: 'ALL', page: 2, limit: 10 }, NOW);
    expect(reader.list.mock.calls[1][0]).toMatchObject({
      scope: { kind: 'ORG', companyId: ORG, excludeUserId: 'sa' },
      statuses: ['PENDING', 'APPROVED', 'REJECTED'],
      skip: 10,
      take: 10,
    });
    await svc.list(ADMIN, { overdue: true, status: 'APPROVED' }, NOW);
    expect(reader.list.mock.calls[2][0]).toMatchObject({
      scope: { kind: 'ORG_ADMIN_MINE', companyId: ORG, excludeUserId: 'admin' },
      statuses: ['PENDING'],
      overdueAt: NOW,
    });
    await svc.list(ADMIN, { status: 'DECIDED', type: 'AWAY' }, NOW);
    expect(reader.list.mock.calls[3][0]).toMatchObject({ statuses: ['APPROVED', 'REJECTED'], type: 'AWAY' });
    await expect(svc.list(me('staff', Role.USER), {}, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(svc.list(me('sa', Role.SUPER_ADMIN, { orgId: null }), {}, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'ORG_REQUIRED',
    });
  });

  it("the summary counts pending, due soon, overdue, escalated and today's decisions with the organisation's SLA", async () => {
    const { svc, reader, settings } = setup();
    reader.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    reader.countDecidedBetween.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    const s = await svc.summary(MGR, NOW);
    expect(s).toEqual({
      pending: 7,
      dueSoon: 2,
      overdue: 1,
      escalated: 1,
      approvedToday: 4,
      rejectedToday: 3,
      slaHours: 48,
    });
    expect(settings.get).toHaveBeenCalledWith(ORG);
    expect(reader.count.mock.calls[1][0].dueWithin).toEqual({
      from: NOW,
      to: new Date(NOW.getTime() + 12 * HOUR),
    });
    expect(reader.count.mock.calls[0][0].scope).toMatchObject({ kind: 'DEPTS', companyId: ORG });
  });

  it("mine lists the caller's own items of the last days (capped at 31)", async () => {
    const { svc, reader } = setup();
    await svc.mine(me('staff', Role.USER), 400, NOW);
    expect(reader.list.mock.calls[0][0]).toMatchObject({
      scope: { kind: 'SUBJECT', userId: 'staff' },
      statuses: ['PENDING', 'APPROVED', 'REJECTED'],
      fromDate: '2026-09-14',
    });
  });
});
