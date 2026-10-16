import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { NoticeEvent } from '@shared/events/notice.event';
import { BreakRecordRow } from '@modules/shifts/domain/break-record.repository';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { MeetingRecordRow } from '../domain/meeting-record.repository';
import { ApprovalsService } from './approvals.service';

const ist = (hm: string, day = 14) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000);
};
const NOW = ist('15:00');
const HOUR = 3600_000;

const person = (
  id: string,
  role: ShiftPerson['role'],
  first: string,
  managerId: string | null,
): ShiftPerson => ({
  id,
  firstName: first,
  lastName: 'Test',
  email: `${id}@x.test`,
  role,
  department: 'Billing',
  designation: null,
  companyId: 'co-1',
  managerId,
  active: true,
});
const people: Record<string, ShiftPerson> = {
  staff: person('staff', 'USER', 'Asha', 'mgr'),
  mgr: person('mgr', 'MANAGER', 'Maya', 'sa'),
  mgr2: person('mgr2', 'MANAGER', 'Arjun', 'sa'),
  sa: person('sa', 'SUPER_ADMIN', 'Sam', null),
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
const MGR = me('mgr', Role.MANAGER);
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
    approverId: 'mgr',
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
    approverId: 'mgr',
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
    decide: jest.fn(
      async (
        _id: string,
        _expected: string[],
        d: {
          status: string;
          decidedById: string | null;
          decidedAt: Date | null;
          note: string | null;
        },
      ) =>
        meeting({
          approvalStatus: d.status as MeetingRecordRow['approvalStatus'],
          decidedById: d.decidedById,
          decidedAt: d.decidedAt,
          decisionNote: d.note,
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
  const settings = { get: jest.fn().mockResolvedValue({ approvalSlaHours: 48 }) };
  const svc = new ApprovalsService(
    reader as never,
    breaks as never,
    meetings as never,
    peopleReader as never,
    events as never,
    breakApprovals as never,
    meetingService as never,
    settings as never,
  );
  const notices = () => events.publish.mock.calls.map(([, p]) => p as NoticeEvent);
  return { svc, reader, breaks, meetings, breakApprovals, meetingService, notices };
}

describe('ApprovalsService deciding meetings', () => {
  it('approves: counted as focus time, and the person hears who decided', async () => {
    const { svc, meetings, notices } = setup();
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

  it("nobody decides their own; a Manager only what is routed to them; a Super Admin anyone else's", async () => {
    const { svc, meetings } = setup();
    meetings.findById.mockResolvedValue(
      meeting({ userId: 'mgr', approverRole: 'SUPER_ADMIN', approverId: null }),
    );
    await expect(svc.approve(MGR, 'meeting', 'm1', undefined, NOW)).rejects.toMatchObject({
      status: 403,
    });
    meetings.findById.mockResolvedValue(meeting());
    await expect(
      svc.approve(me('mgr2', Role.MANAGER), 'meeting', 'm1', undefined, NOW),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.approve(me('staff2', Role.USER), 'meeting', 'm1', undefined, NOW),
    ).rejects.toMatchObject({ status: 403 });
    await expect(svc.approve(SA, 'meeting', 'm1', undefined, NOW)).resolves.toMatchObject({
      status: 'APPROVED',
    });
  });

  it('a live meeting is healed first and cannot be decided while it runs', async () => {
    const { svc, meetings, meetingService } = setup();
    meetings.findById.mockResolvedValue(
      meeting({ mode: 'LIVE', endedAt: null, durationSec: null }),
    );
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

  it('reopens: only the decider or a Super Admin, only a decided meeting', async () => {
    const { svc, meetings } = setup();
    meetings.findById.mockResolvedValue(
      meeting({ approvalStatus: 'REJECTED', decidedById: 'sa', approverId: 'mgr' }),
    );
    await expect(svc.reopen(MGR, 'meeting', 'm1', NOW)).rejects.toMatchObject({ status: 403 });
    const item = await svc.reopen(SA, 'meeting', 'm1', NOW);
    expect(meetings.decide).toHaveBeenCalledWith('m1', ['APPROVED', 'REJECTED'], {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    expect(item.status).toBe('PENDING');
    meetings.findById.mockResolvedValue(meeting());
    await expect(svc.reopen(SA, 'meeting', 'm1', NOW)).rejects.toMatchObject({
      code: 'NOT_DECIDED',
    });
  });
});

describe('ApprovalsService deciding breaks', () => {
  it('goes through the break approvals use case and returns the item', async () => {
    const { svc, breakApprovals } = setup();
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
    });
  });

  it('bulk approve skips repeats and reports what could not be approved', async () => {
    const { svc, breakApprovals, meetings } = setup();
    breakApprovals.decideRecord.mockRejectedValueOnce(new Error('Already approved.'));
    meetings.findById.mockResolvedValue(meeting());
    const res = await svc.bulkApprove(
      MGR,
      [
        { type: 'break', id: 'b1' },
        { type: 'break', id: 'b1' },
        { type: 'break', id: 'b2' },
        { type: 'meeting', id: 'm1' },
      ],
      undefined,
      NOW,
    );
    expect(res.skipped).toEqual([{ type: 'break', id: 'b1', reason: 'Already approved.' }]);
    expect(res.approved).toEqual([
      { type: 'break', id: 'b2' },
      { type: 'meeting', id: 'm1' },
    ]);
    expect(breakApprovals.decideRecord).toHaveBeenCalledTimes(2);
  });
});

describe('ApprovalsService views and lists', () => {
  it('keeps the order, drops records needing no approval, flags overdue, and locks decided months', async () => {
    const { svc, reader, breaks, meetings } = setup();
    breaks.listByIds.mockResolvedValue([
      skip({
        id: 'b-old',
        date: '2026-09-28',
        dueAt: ist('10:00', 13),
        escalatedAt: ist('10:15', 13),
      }),
      skip({
        id: 'b-sa',
        userId: 'sa',
        approvalStatus: 'NOT_REQUIRED',
        approverRole: null,
        approverId: null,
      }),
    ]);
    meetings.listByIds.mockResolvedValue([meeting({ dueAt: new Date(NOW.getTime() + 2 * HOUR) })]);
    reader.lockedMonths.mockResolvedValue(new Set(['2026-09']));
    const items = await svc.views(
      MGR,
      [
        { type: 'MEETING', id: 'm1' },
        { type: 'BREAK', id: 'b-sa' },
        { type: 'BREAK', id: 'b-old' },
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['m1', 'b-old']);
    expect(items[0]).toMatchObject({
      dueSoon: true,
      overdue: false,
      canDecide: true,
      locked: false,
    });
    expect(items[1]).toMatchObject({
      overdue: true,
      dueSoon: false,
      escalated: true,
      locked: true,
      canDecide: false,
    });
  });

  it('a Manager always lists their own; a Super Admin may ask for everything; overdue means pending past due', async () => {
    const { svc, reader } = setup();
    await svc.list(MGR, { scope: 'all' }, NOW);
    expect(reader.list.mock.calls[0][0]).toMatchObject({
      scope: { kind: 'APPROVER', approverId: 'mgr' },
      statuses: ['PENDING'],
      skip: 0,
      take: 50,
    });
    await svc.list(SA, { scope: 'all', status: 'ALL', page: 2, limit: 10 }, NOW);
    expect(reader.list.mock.calls[1][0]).toMatchObject({
      scope: { kind: 'ALL' },
      statuses: ['PENDING', 'APPROVED', 'REJECTED'],
      skip: 10,
      take: 10,
    });
    await svc.list(SA, { overdue: true, status: 'APPROVED' }, NOW);
    expect(reader.list.mock.calls[2][0]).toMatchObject({
      scope: { kind: 'SUPER_ADMIN_MINE', approverId: 'sa' },
      statuses: ['PENDING'],
      overdueAt: NOW,
    });
    await expect(svc.list(me('staff', Role.USER), {}, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it('the summary counts pending, due soon, overdue, escalated and today’s decisions', async () => {
    const { svc, reader } = setup();
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
    expect(reader.count.mock.calls[1][0].dueWithin).toEqual({
      from: NOW,
      to: new Date(NOW.getTime() + 12 * HOUR),
    });
  });
});
