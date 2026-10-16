import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { BreakDayService } from '../break-day.service';
import { MyBreaksUseCase } from './my-breaks.use-case';
import { ShiftRecord } from '../../domain/shift.types';
import { ShiftPerson } from '../../domain/shift-people.reader';
import { BreakRecordRow, NewBreakRecord } from '../../domain/break-record.repository';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

/** An IST wall time on Tue 13 Oct 2026 as an instant. */
const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60_000);
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
  overrunGraceMin: 2,
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

const people: Record<string, ShiftPerson> = {
  staff: {
    id: 'staff',
    firstName: 'Asha',
    lastName: 'K',
    email: 'a@x.test',
    role: 'USER',
    department: 'Support',
    designation: null,
    companyId: 'co-1',
    managerId: 'mgr',
    active: true,
  },
  mgr: {
    id: 'mgr',
    firstName: 'Maya',
    lastName: 'R',
    email: 'm@x.test',
    role: 'MANAGER',
    department: 'Support',
    designation: null,
    companyId: 'co-1',
    managerId: 'sa',
    active: true,
  },
  sa: {
    id: 'sa',
    firstName: 'Sam',
    lastName: 'A',
    email: 's@x.test',
    role: 'SUPER_ADMIN',
    department: null,
    designation: null,
    companyId: 'co-1',
    managerId: null,
    active: true,
  },
};

const me = (id: string, role: Role): AuthenticatedUser => ({
  id,
  email: `${id}@x.test`,
  role,
  permissions: [],
  department: null,
  companyId: 'co-1',
  status: 'ACTIVE',
});

function startedRow(input: NewBreakRecord): BreakRecordRow {
  return {
    ...input,
    id: 'rec-1',
    seq: 0,
    presenceSessionId: 'ps-1',
    endedAt: null,
    overrunReason: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: input.startedAt,
  };
}

describe('MyBreaksUseCase', () => {
  const records = {
    listForUserOnDate: jest.fn(),
    findOpenForUser: jest.fn(),
    startScheduled: jest.fn(),
    markOverrun: jest.fn(),
    finishBreak: jest.fn(),
    findById: jest.fn(),
    listForUserBetween: jest.fn(),
  };
  const shiftsRepo = {
    list: jest.fn(),
    listAssignmentsFor: jest.fn(),
    listAllAssignments: jest.fn(),
    findById: jest.fn(),
  };
  const peopleReader = {
    findById: jest.fn(async (id: string) => people[id] ?? null),
    findAnyByIds: jest.fn(async () => []),
    listSuperAdminIds: jest.fn(async () => ['sa']),
  };
  const presence = {
    dayEnded: jest.fn(async () => false),
    findOpen: jest.fn(),
    endOpen: jest.fn(),
    broadcast: jest.fn(async () => undefined),
  };
  const events = { approvalRequested: jest.fn(async () => undefined), decided: jest.fn() };
  let useCase: MyBreaksUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    shiftsRepo.list.mockResolvedValue([general]);
    shiftsRepo.listAssignmentsFor.mockResolvedValue([]);
    shiftsRepo.listAllAssignments.mockResolvedValue([]);
    shiftsRepo.findById.mockResolvedValue(general);
    records.listForUserOnDate.mockResolvedValue([]);
    records.findOpenForUser.mockResolvedValue(null);
    records.startScheduled.mockImplementation(async (rec: NewBreakRecord) => ({
      ok: true,
      record: startedRow(rec),
      presenceSessionId: 'ps-1',
      closedMeeting: false,
    }));
    useCase = new MyBreaksUseCase(
      records as never,
      peopleReader as never,
      shiftsRepo as never,
      new BreakDayService(shiftsRepo as never),
      presence as never,
      events as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  const at = (hm: string) =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(ist(hm));

  it("shows today's three breaks with local times", async () => {
    at('10:00');
    const day = await useCase.today(me('staff', Role.USER));
    expect(day.mode).toBe('SCHEDULED');
    expect(day.date).toBe('2026-10-13');
    expect(day.breaks.map((b) => [b.kind, b.local.start, b.local.ringStart])).toEqual([
      ['MORNING', '11:00', '10:59'],
      ['LUNCH', '13:00', '12:59'],
      ['EVENING', '16:00', '15:59'],
    ]);
    expect(day.shift?.rules.reasonMinChars).toBe(10);
  });

  it('is FREE on a day off', async () => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date(Date.UTC(2026, 9, 18, 6, 0)));
    const day = await useCase.today(me('staff', Role.USER));
    expect(day.mode).toBe('FREE');
    expect(day.workday).toBe(false);
    expect(day.breaks).toEqual([]);
  });

  it('starts on time while ringing with no reason and no approval', async () => {
    at('11:02');
    const res = await useCase.start(me('staff', Role.USER), { kind: 'MORNING' });
    expect(res.record.timing).toBe('ON_TIME');
    const written = records.startScheduled.mock.calls[0][0];
    expect(written).toMatchObject({
      kind: 'MORNING',
      approvalStatus: 'NOT_REQUIRED',
      reason: null,
      durationMin: 15,
      shiftName: 'General',
    });
    expect(records.startScheduled.mock.calls[0][1]).toEqual({ calendarDay: '2026-10-13' });
    expect(events.approvalRequested).not.toHaveBeenCalled();
    expect(presence.broadcast).toHaveBeenCalled();
  });

  it('asks for a reason when late, then routes to the manager', async () => {
    at('11:20');
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
      status: 422,
      details: { timing: 'LATE', minutesOff: 20, minChars: 10 },
    });
    await expect(
      useCase.start(me('staff', Role.USER), { kind: 'MORNING', reason: 'too short' }),
    ).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    const res = await useCase.start(me('staff', Role.USER), {
      kind: 'MORNING',
      reason: '  Customer   escalation call ',
    });
    expect(res.record.approvalStatus).toBe('PENDING');
    expect(records.startScheduled.mock.calls[0][0]).toMatchObject({
      reason: 'Customer escalation call',
      approverRole: 'MANAGER',
      approverId: 'mgr',
      timing: 'LATE',
      minutesOff: 20,
    });
    expect(events.approvalRequested).toHaveBeenCalledTimes(1);
  });

  it("sends a manager's early break to the Super Admin pool", async () => {
    at('10:35');
    await useCase.start(me('mgr', Role.MANAGER), {
      kind: 'MORNING',
      reason: 'Client call at eleven',
    });
    expect(records.startScheduled.mock.calls[0][0]).toMatchObject({
      timing: 'EARLY',
      minutesOff: 25,
      approvalStatus: 'PENDING',
      approverRole: 'SUPER_ADMIN',
      approverId: null,
    });
  });

  it('never asks a Super Admin for approval', async () => {
    at('11:30');
    await useCase.start(me('sa', Role.SUPER_ADMIN), {
      kind: 'MORNING',
      reason: 'Board meeting overran',
    });
    expect(records.startScheduled.mock.calls[0][0].approvalStatus).toBe('NOT_REQUIRED');
  });

  it('does not ask a Super Admin for a reason (nobody reviews it), but records the timing', async () => {
    at('11:30');
    const res = await useCase.start(me('sa', Role.SUPER_ADMIN), { kind: 'MORNING' });
    expect(res.record.timing).toBe('LATE');
    expect(records.startScheduled.mock.calls[0][0]).toMatchObject({
      timing: 'LATE',
      minutesOff: 30,
      reason: null,
      approvalStatus: 'NOT_REQUIRED',
    });
    expect(events.approvalRequested).not.toHaveBeenCalled();
  });

  it("shows a Super Admin rules that ask for no reason or overrun note; others keep the shift's", async () => {
    at('10:00');
    const sa = await useCase.today(me('sa', Role.SUPER_ADMIN));
    expect(sa.shift?.rules).toMatchObject({
      reasonOnEarly: false,
      reasonOnLate: false,
      overrunReason: false,
    });
    const staff = await useCase.today(me('staff', Role.USER));
    expect(staff.shift?.rules).toMatchObject({
      reasonOnEarly: true,
      reasonOnLate: true,
      overrunReason: true,
    });
  });

  it('refuses before the window opens and after it closes', async () => {
    at('10:10');
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'BREAK_NOT_OPEN',
      message: 'Your morning break opens at 10:30.',
    });
    at('12:05');
    await expect(
      useCase.start(me('staff', Role.USER), { kind: 'MORNING', reason: 'Long meeting today' }),
    ).rejects.toMatchObject({
      code: 'BREAK_WINDOW_CLOSED',
    });
  });

  it('refuses the morning break once lunch was taken', async () => {
    at('11:30');
    records.listForUserOnDate.mockResolvedValue([{ id: 'l', kind: 'LUNCH', date: '2026-10-13' }]);
    await expect(
      useCase.start(me('staff', Role.USER), { kind: 'MORNING', reason: 'Was busy before lunch' }),
    ).rejects.toMatchObject({
      code: 'BREAK_ORDER',
    });
  });

  it('refuses a break already taken today', async () => {
    at('11:01');
    records.listForUserOnDate.mockResolvedValue([{ id: 'm', kind: 'MORNING', date: '2026-10-13' }]);
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'BREAK_ALREADY_TAKEN',
    });
  });

  it('an auto-skip End Day made in this still-open window gives way to the real break', async () => {
    at('11:02');
    const endDaySkip = {
      id: 'auto',
      kind: 'MORNING',
      date: '2026-10-13',
      outcome: 'AUTO_SKIPPED',
      reason: null,
      startedAt: ist('11:01'),
      windowClose: ist('12:00'),
    };
    records.listForUserOnDate.mockResolvedValue([endDaySkip]);
    await useCase.start(me('staff', Role.USER), { kind: 'MORNING' });
    expect(records.startScheduled).toHaveBeenCalled();

    // Once commented, or made after the window closed, it stays: already taken.
    for (const kept of [
      { ...endDaySkip, reason: 'Client call' },
      { ...endDaySkip, startedAt: ist('12:00') },
    ]) {
      records.listForUserOnDate.mockResolvedValue([kept]);
      await expect(
        useCase.start(me('staff', Role.USER), { kind: 'MORNING' }),
      ).rejects.toMatchObject({
        code: 'BREAK_ALREADY_TAKEN',
      });
    }
  });

  it('maps a refused start to a clear conflict', async () => {
    at('11:01');
    records.startScheduled.mockResolvedValueOnce({ ok: false, reason: 'DAY_ENDED' });
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'DAY_ENDED',
    });
    records.startScheduled.mockResolvedValueOnce({ ok: false, reason: 'ALREADY_ON_BREAK' });
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'ALREADY_ON_BREAK',
    });
  });

  it('says when no such break is scheduled', async () => {
    at('11:01');
    shiftsRepo.list.mockResolvedValue([]);
    await expect(useCase.start(me('staff', Role.USER), { kind: 'MORNING' })).rejects.toMatchObject({
      code: 'BREAK_NOT_SCHEDULED',
    });
  });

  describe('end', () => {
    const open = (over: Partial<BreakRecordRow> = {}): BreakRecordRow =>
      ({
        id: 'rec-1',
        userId: 'staff',
        kind: 'MORNING',
        shiftId: 'shift-general',
        durationMin: 15,
        startedAt: ist('11:00'),
        endedAt: null,
        approvalStatus: 'NOT_REQUIRED',
        approverRole: null,
        approverId: null,
        reason: null,
        overrunReason: null,
        ...over,
      }) as BreakRecordRow;

    it('is a no-op when nothing is running', async () => {
      at('11:20');
      presence.findOpen.mockResolvedValue(null);
      await expect(useCase.end(me('staff', Role.USER), {})).resolves.toEqual({
        ended: false,
        record: null,
      });
      expect(presence.endOpen).not.toHaveBeenCalled();
    });

    it('ends a plain break from the older flow too', async () => {
      at('11:20');
      presence.findOpen.mockResolvedValue({ id: 's', type: 'LUNCH' });
      await expect(useCase.end(me('staff', Role.USER), {})).resolves.toEqual({
        ended: true,
        record: null,
      });
      expect(presence.endOpen).toHaveBeenCalledWith('staff', expect.any(Date));
    });

    it('does not touch a meeting', async () => {
      at('11:20');
      presence.findOpen.mockResolvedValue({ id: 's', type: 'MEETING' });
      await expect(useCase.end(me('staff', Role.USER), {})).resolves.toEqual({
        ended: false,
        record: null,
      });
      expect(presence.endOpen).not.toHaveBeenCalled();
    });

    // 3.1 (SPEC 1.5) replaced the 3.0 rule "an overrun the shift wants explained
    // always goes for approval": now only an ask does, and overrunSec is always stored.
    const finishedAs = (row: BreakRecordRow, becamePending = false) =>
      records.finishBreak.mockResolvedValue({ row, becamePending });

    it('ends within its length without asking anything, storing overrunSec 0', async () => {
      at('11:14');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:14') });
      const res = await useCase.end(me('staff', Role.USER), {});
      expect(res.ended).toBe(true);
      expect(records.finishBreak).toHaveBeenCalledWith(
        'rec-1',
        { overrunSec: 0, ask: null },
        expect.any(Date),
      );
      expect(events.approvalRequested).not.toHaveBeenCalled();
    });

    it('leaves the minutes out when nothing is asked, even if the shift wanted a reason', async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:25') });
      const res = await useCase.end(me('staff', Role.USER), {});
      expect(res.ended).toBe(true);
      expect(records.finishBreak).toHaveBeenCalledWith(
        'rec-1',
        { overrunSec: 600, ask: null },
        expect.any(Date),
      );
      expect(events.approvalRequested).not.toHaveBeenCalled();
    });

    it('asks to count the overrun with askToCount and a reason, routed to the manager', async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:25'), approvalStatus: 'PENDING' }, true);
      const res = await useCase.end(me('staff', Role.USER), {
        askToCount: true,
        overrunReason: '  Customer call  ran long ',
      });
      expect(res.ended).toBe(true);
      expect(records.finishBreak).toHaveBeenCalledWith(
        'rec-1',
        {
          overrunSec: 600,
          ask: {
            reason: 'Customer call ran long',
            routing: { approverRole: 'MANAGER', approverId: 'mgr' },
          },
        },
        expect.any(Date),
      );
      expect(events.approvalRequested).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rec-1' }),
        people.staff,
        true,
      );
    });

    it('refuses askToCount without enough text, and the break keeps running', async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open());
      await expect(
        useCase.end(me('staff', Role.USER), { askToCount: true, overrunReason: 'late' }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'REASON_REQUIRED',
        details: { minChars: 10, overrunSec: 600 },
      });
      expect(presence.endOpen).not.toHaveBeenCalled();
      expect(records.finishBreak).not.toHaveBeenCalled();
    });

    it("treats an older agent's reason as an ask and never refuses it", async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:25'), approvalStatus: 'PENDING' }, true);
      await useCase.end(me('staff', Role.USER), { overrunReason: 'bus' });
      expect(records.finishBreak.mock.calls[0][1]).toMatchObject({
        ask: { reason: 'bus', routing: { approverId: 'mgr' } },
      });
    });

    it('leaves the minutes out when askToCount is false, whatever the text', async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:25') });
      await useCase.end(me('staff', Role.USER), {
        askToCount: false,
        overrunReason: 'Customer call ran long',
      });
      expect(records.finishBreak.mock.calls[0][1]).toEqual({ overrunSec: 600, ask: null });
    });

    it("never sends a Super Admin's overrun for approval and never asks them for text", async () => {
      at('11:25');
      records.findOpenForUser.mockResolvedValue(open({ userId: 'sa' }));
      finishedAs({ ...open({ userId: 'sa' }), endedAt: ist('11:25') });
      const res = await useCase.end(me('sa', Role.SUPER_ADMIN), { askToCount: true });
      expect(res.ended).toBe(true);
      expect(records.finishBreak.mock.calls[0][1]).toEqual({
        overrunSec: 600,
        ask: { reason: null, routing: null },
      });
      expect(events.approvalRequested).not.toHaveBeenCalled();
    });

    it('keeps an overrun inside the grace minutes quiet, even when asked', async () => {
      at('11:16');
      records.findOpenForUser.mockResolvedValue(open());
      finishedAs({ ...open(), endedAt: ist('11:16') });
      await useCase.end(me('staff', Role.USER), { askToCount: true, overrunReason: 'Short call' });
      expect(records.finishBreak.mock.calls[0][1]).toEqual({ overrunSec: 60, ask: null });
    });
  });

  it('caps history at 31 days', async () => {
    at('12:00');
    records.listForUserBetween.mockResolvedValue([]);
    const h = await useCase.history(me('staff', Role.USER), 400);
    expect(h).toMatchObject({ from: '2026-09-13', to: '2026-10-13', items: [] });
  });
});
