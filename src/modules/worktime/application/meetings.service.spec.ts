import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ConflictError } from '@shared/exceptions/app.exception';
import { NoticeEvent } from '@shared/events/notice.event';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { MeetingRecordRow, NewMeeting } from '../domain/meeting-record.repository';
import { MeetingsService, meetingView } from './meetings.service';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 14, h, m) - 330 * 60_000);
};
const NOW = ist('11:00');

const people: Record<string, ShiftPerson> = {
  staff: {
    id: 'staff',
    firstName: 'Asha',
    lastName: 'Rao',
    email: 'a@x.test',
    role: 'USER',
    department: 'Coding',
    designation: null,
    companyId: 'co-1',
    departmentId: 'dept-coding',
    managerId: 'mgr',
    active: true,
  },
  mgr: {
    id: 'mgr',
    firstName: 'Maya',
    lastName: 'Reddy',
    email: 'm@x.test',
    role: 'MANAGER',
    department: 'Coding',
    designation: null,
    companyId: 'co-1',
    departmentId: 'dept-coding',
    managerId: 'sa',
    active: true,
  },
  sa: {
    id: 'sa',
    firstName: 'Sam',
    lastName: 'Admin',
    email: 's@x.test',
    role: 'SUPER_ADMIN',
    department: null,
    designation: null,
    companyId: 'co-1',
    departmentId: null,
    managerId: null,
    active: true,
  },
  admin: {
    id: 'admin',
    firstName: 'Ada',
    lastName: 'Min',
    email: 'ad@x.test',
    role: 'ADMIN',
    department: null,
    designation: null,
    companyId: 'co-1',
    departmentId: null,
    managerId: null,
    active: true,
  },
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

function meeting(over: Partial<MeetingRecordRow> = {}): MeetingRecordRow {
  return {
    id: 'm1',
    userId: 'staff',
    date: '2026-10-14',
    mode: 'LIVE',
    agenda: 'Sprint review',
    participants: [],
    startedAt: ist('10:00'),
    endedAt: ist('10:45'),
    durationSec: 45 * 60,
    presenceSessionId: 'ps1',
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    dueAt: new Date(ist('10:00').getTime() + 48 * 3600_000),
    escalatedAt: null,
    remindedAt: null,
    createdAt: ist('10:00'),
    ...over,
  };
}

function setup() {
  const repo = {
    findById: jest.fn().mockResolvedValue(meeting()),
    startLive: jest.fn(async (input: { agenda: string }, _g: string) => ({
      ok: true,
      record: meeting({ endedAt: null, durationSec: null, agenda: input.agenda, startedAt: NOW }),
      presenceSessionId: 'ps9',
      closedSessionType: null,
    })),
    endLive: jest.fn().mockResolvedValue({ kind: 'ENDED', record: meeting() }),
    createPast: jest.fn(async (input: { startedAt: Date; durationSec: number }) => ({
      ok: true,
      record: meeting({
        mode: 'PAST',
        presenceSessionId: null,
        startedAt: input.startedAt,
        endedAt: new Date(input.startedAt.getTime() + input.durationSec * 1000),
        durationSec: input.durationSec,
      }),
    })),
    heal: jest.fn().mockResolvedValue({ healed: [], discarded: 0 }),
    listForUserOnDate: jest.fn().mockResolvedValue([]),
    findRunning: jest.fn().mockResolvedValue(null),
    confirmStatus: jest.fn().mockResolvedValue({ kind: 'NONE' }),
    listStatusUnanswered: jest.fn().mockResolvedValue([]),
    endStatusUnanswered: jest.fn().mockResolvedValue(null),
  };
  const peopleReader = {
    findById: jest.fn(async (id: string) => people[id] ?? null),
    findAnyByIds: jest.fn(async (ids: string[]) => ids.map((id) => people[id]).filter(Boolean)),
  };
  const reader = {
    knownPeopleIds: jest.fn(async () => new Set(['mgr'])),
    searchParticipants: jest.fn(),
  };
  const events = {
    publish: jest.fn(async (_n: string, _p: unknown) => undefined),
    subscribe: jest.fn(),
  };
  const sessions = {
    assertAgentDay: jest.fn().mockResolvedValue(undefined),
    autoCloseIfStale: jest.fn().mockResolvedValue(false),
    todayFor: jest.fn().mockResolvedValue('2026-10-14'),
    findOpen: jest.fn().mockResolvedValue(null),
  };
  const breakEvents = { recipientsFor: jest.fn().mockResolvedValue(['mgr']) };
  const presence = {
    broadcast: jest.fn().mockResolvedValue(undefined),
    endOpen: jest.fn().mockResolvedValue(null),
  };
  const svc = new MeetingsService(
    repo as never,
    peopleReader as never,
    reader as never,
    events as never,
    sessions as never,
    breakEvents as never,
    presence as never,
  );
  const notices = () => events.publish.mock.calls.map(([, p]) => p as NoticeEvent);
  return { svc, repo, reader, events, notices, presence, sessions };
}

describe('MeetingsService.start', () => {
  it("opens a live meeting routed to the department's managers, with clean participants", async () => {
    const { svc, repo, notices } = setup();
    const res = await svc.start(
      me('staff', Role.USER),
      {
        agenda: '  Sprint   review ',
        participants: [{ id: 'mgr', name: 'Maya' }, { id: 'ghost', name: 'Ravi' }, { name: ' ' }],
      },
      'AGENT_31',
      NOW,
    );
    const input = repo.startLive.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(input).toMatchObject({
      userId: 'staff',
      date: '2026-10-14',
      agenda: 'Sprint review',
      participants: [{ id: 'mgr', name: 'Maya' }, { name: 'Ravi' }],
      approvalStatus: 'PENDING',
      // 4.0: routed by department; no approver id is written.
      routing: { approverRole: 'MANAGER', approverId: null },
      momSender: null,
    });
    expect(repo.startLive.mock.calls[0][1]).toBe('AGENT_31');
    expect(res.presence).toMatchObject({
      status: 'MEETING',
      sessionId: 'ps9',
      note: 'Sprint review',
      elapsedSec: 0,
    });
    expect(res.meeting.inProgress).toBe(true);
    // The approver hears about it once it has ended, not now.
    expect(notices()).toHaveLength(0);
  });

  it("a night shift's meeting after midnight is dated by its working day", async () => {
    const { svc, repo, sessions } = setup();
    sessions.todayFor.mockResolvedValueOnce('2026-10-13');
    await svc.start(
      me('staff', Role.USER),
      { participants: [], agenda: 'Handover' },
      'AGENT_31',
      NOW,
    );
    expect(repo.startLive.mock.calls[0][0]).toMatchObject({ date: '2026-10-13' });
    expect((repo.startLive.mock.calls[0] as unknown[])[3]).toBe('2026-10-13');
  });

  it("a Super Admin's or an Admin's meeting needs no approval", async () => {
    const { svc, repo } = setup();
    await svc.start(
      me('sa', Role.SUPER_ADMIN),
      { participants: [], agenda: 'Board call' },
      'AGENT_31',
      NOW,
    );
    await svc.start(
      me('admin', Role.ADMIN),
      { participants: [], agenda: 'Org review' },
      'AGENT_31',
      NOW,
    );
    for (const call of repo.startLive.mock.calls) {
      expect(call[0]).toMatchObject({
        approvalStatus: 'NOT_REQUIRED',
        routing: { approverRole: null, approverId: null },
      });
    }
  });

  it("a Manager's meeting goes to the organisation Admin", async () => {
    const { svc, repo } = setup();
    await svc.start(
      me('mgr', Role.MANAGER),
      { participants: [], agenda: 'Team sync' },
      'AGENT_31',
      NOW,
    );
    expect(repo.startLive.mock.calls[0][0]).toMatchObject({
      approvalStatus: 'PENDING',
      routing: { approverRole: 'ADMIN', approverId: null },
    });
  });

  it('a 4.0 agent must say who mails the minutes (2 to 80 characters); a 3.x agent may leave it out', async () => {
    const { svc, repo } = setup();
    for (const momSender of [undefined, '', '  ', 'A', 'x'.repeat(81)]) {
      await expect(
        svc.start(
          me('staff', Role.USER),
          { participants: [], agenda: 'Sync', momSender },
          'AGENT_31',
          NOW,
          { agent40: true },
        ),
      ).rejects.toMatchObject({
        status: 422,
        code: 'MOM_SENDER_REQUIRED',
        details: { field: 'momSender' },
      });
    }
    expect(repo.startLive).not.toHaveBeenCalled();

    const res = await svc.start(
      me('staff', Role.USER),
      { participants: [], agenda: 'Sync', momSender: '  Maya   Reddy ' },
      'AGENT_31',
      NOW,
      { agent40: true },
    );
    expect(repo.startLive.mock.calls[0][0]).toMatchObject({ momSender: 'Maya Reddy' });
    expect(res.meeting).toHaveProperty('momSender');

    // 3.x: optional, but a given one is still checked.
    await svc.start(me('staff', Role.USER), { participants: [], agenda: 'Sync' }, 'AGENT_31', NOW);
    expect(repo.startLive.mock.calls[1][0]).toMatchObject({ momSender: null });
    await expect(
      svc.start(
        me('staff', Role.USER),
        { participants: [], agenda: 'Sync', momSender: 'A' },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'MOM_SENDER_REQUIRED' });
  });

  it('refuses a blank or long agenda before touching the day', async () => {
    const { svc, repo } = setup();
    await expect(
      svc.start(me('staff', Role.USER), { participants: [], agenda: '   ' }, 'AGENT_31', NOW),
    ).rejects.toMatchObject({
      status: 400,
      details: { field: 'agenda' },
    });
    await expect(
      svc.start(
        me('staff', Role.USER),
        { participants: [], agenda: 'x'.repeat(301) },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(repo.startLive).not.toHaveBeenCalled();
  });

  it.each(['ON_BREAK', 'MEETING_IN_PROGRESS', 'DAY_NOT_STARTED', 'DAY_ENDED'])(
    'answers %s with a 409',
    async (code) => {
      const { svc, repo } = setup();
      repo.startLive.mockResolvedValueOnce({ ok: false, code } as never);
      await expect(
        svc.start(me('staff', Role.USER), { participants: [], agenda: 'Sync' }, 'AGENT_31', NOW),
      ).rejects.toMatchObject({
        status: 409,
        code,
      });
    },
  );
});

describe('MeetingsService.end', () => {
  it('ends my live meeting and tells the approver it waits', async () => {
    const { svc, repo, notices } = setup();
    const res = await svc.end(me('staff', Role.USER), 'm1', NOW);
    expect(repo.endLive).toHaveBeenCalledWith('m1', 'staff', NOW);
    expect(res).toMatchObject({
      discarded: false,
      meeting: { id: 'm1', inProgress: false, durationSec: 2700 },
    });
    expect(notices()[0]).toMatchObject({
      recipientIds: ['mgr'],
      type: 'MEETING_REQUESTED',
      fromUserId: 'staff',
    });
    expect(notices()[0].title).toContain('Asha Rao');
    // 12-hour times in the notice (10:00 to 10:45 in India).
    expect(notices()[0].body).toBe('45 min, 10:00 AM to 10:45 AM. Review it in Approvals.');
  });

  it('a meeting under a minute is discarded, and every repeat says so', async () => {
    const { svc, repo, events } = setup();
    // The discarded meeting is kept (NOT_REQUIRED), so ending it again finds it.
    repo.findById.mockResolvedValue(
      meeting({ approvalStatus: 'NOT_REQUIRED', durationSec: 40, endedAt: ist('10:00') }),
    );
    repo.endLive.mockResolvedValue({ kind: 'DISCARDED' });
    for (let i = 0; i < 3; i++) {
      expect(await svc.end(me('staff', Role.USER), 'm1', NOW)).toEqual({
        meeting: null,
        discarded: true,
      });
    }
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('ending a meeting that already ended changes nothing', async () => {
    const { svc, repo, events } = setup();
    repo.endLive.mockResolvedValueOnce({ kind: 'UNCHANGED', record: meeting() });
    expect((await svc.end(me('staff', Role.USER), 'm1', NOW)).discarded).toBe(false);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it("404 for an unknown meeting and for someone else's (existence never leaks)", async () => {
    const { svc, repo } = setup();
    repo.findById.mockResolvedValueOnce(null);
    const unknown = await svc.end(me('staff', Role.USER), 'nope', NOW).catch((e) => e);
    const theirs = await svc.end(me('mgr', Role.MANAGER), 'm1', NOW).catch((e) => e);
    expect(unknown).toMatchObject({ status: 404 });
    expect(theirs).toMatchObject({ status: 404, code: unknown.code, message: unknown.message });
    expect(repo.endLive).not.toHaveBeenCalled();
  });
});

describe('MeetingsService.logPast', () => {
  it('logs an earlier meeting and tells the approver', async () => {
    const { svc, repo, notices } = setup();
    const res = await svc.logPast(
      me('staff', Role.USER),
      {
        participants: [],
        agenda: 'Client call',
        startedAt: ist('09:45').toISOString(),
        durationMin: 30,
      },
      'AGENT_31',
      NOW,
    );
    expect(repo.createPast.mock.calls[0][0]).toMatchObject({
      startedAt: ist('09:45'),
      durationSec: 1800,
      approvalStatus: 'PENDING',
      routing: { approverRole: 'MANAGER', approverId: null },
    });
    expect(res.meeting.mode).toBe('PAST');
    expect(notices()[0].type).toBe('MEETING_REQUESTED');
  });

  it('a 4.0 agent logging an earlier meeting must name the minutes sender too', async () => {
    const { svc, repo } = setup();
    const dto = {
      participants: [],
      agenda: 'Client call',
      startedAt: ist('09:45').toISOString(),
      durationMin: 30,
    };
    await expect(
      svc.logPast(me('staff', Role.USER), dto, 'AGENT_31', NOW, { agent40: true }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'MOM_SENDER_REQUIRED',
    });
    await svc.logPast(me('staff', Role.USER), { ...dto, momSender: 'Asha' }, 'AGENT_31', NOW, {
      agent40: true,
    });
    expect(repo.createPast.mock.calls[0][0]).toMatchObject({ momSender: 'Asha' });
  });

  it('refuses a startedAt that is not a time', async () => {
    const { svc, repo } = setup();
    await expect(
      svc.logPast(
        me('staff', Role.USER),
        { participants: [], agenda: 'Call', startedAt: 'soon', durationMin: 30 },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({ status: 400, details: { field: 'startedAt' } });
    expect(repo.createPast).not.toHaveBeenCalled();
  });

  it('answers a conflict with 422 and what it collides with', async () => {
    const { svc, repo } = setup();
    const withBreak = {
      kind: 'LUNCH',
      startedAt: ist('10:00').toISOString(),
      endedAt: ist('10:30').toISOString(),
    };
    repo.createPast.mockResolvedValueOnce({
      ok: false,
      conflict: { code: 'MEETING_OVERLAPS_BREAK', with: withBreak },
    } as never);
    await expect(
      svc.logPast(
        me('staff', Role.USER),
        {
          participants: [],
          agenda: 'Call',
          startedAt: ist('10:15').toISOString(),
          durationMin: 30,
        },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'MEETING_OVERLAPS_BREAK',
      details: { with: withBreak },
    });
    repo.createPast.mockResolvedValueOnce({
      ok: false,
      conflict: { code: 'MEETING_IN_FUTURE' },
    } as never);
    await expect(
      svc.logPast(
        me('staff', Role.USER),
        {
          participants: [],
          agenda: 'Call',
          startedAt: ist('10:45').toISOString(),
          durationMin: 30,
        },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'MEETING_IN_FUTURE' });
    repo.createPast.mockResolvedValueOnce({ ok: false, code: 'DAY_NOT_STARTED' } as never);
    await expect(
      svc.logPast(
        me('staff', Role.USER),
        {
          participants: [],
          agenda: 'Call',
          startedAt: ist('09:00').toISOString(),
          durationMin: 30,
        },
        'AGENT_31',
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'DAY_NOT_STARTED' });
  });
});

describe('MeetingsService.heal', () => {
  it('tells the approver about every meeting it ended', async () => {
    const { svc, repo, notices } = setup();
    repo.heal.mockResolvedValueOnce({
      healed: [meeting({ id: 'a' }), meeting({ id: 'b', approvalStatus: 'NOT_REQUIRED' })],
      discarded: 1,
    });
    await svc.heal(['staff'], NOW);
    expect(repo.heal).toHaveBeenCalledWith(['staff']);
    expect(notices()).toHaveLength(1);
  });
});

describe('MeetingsService: biometric staff (D-23)', () => {
  const refused = new ConflictError('By the device.', 'ATTENDANCE_BY_BIOMETRIC');

  it('a live meeting is refused before anything opens', async () => {
    const { svc, repo, sessions } = setup();
    sessions.assertAgentDay.mockRejectedValue(refused);
    await expect(
      svc.start(me('staff', Role.USER), { agenda: 'Review', participants: [] }, 'LEGACY', NOW),
    ).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_BY_BIOMETRIC' });
    expect(sessions.assertAgentDay).toHaveBeenCalledWith('staff', 'act');
    expect(repo.startLive).not.toHaveBeenCalled();
  });

  it('a logged meeting is refused too', async () => {
    const { svc, repo, sessions } = setup();
    sessions.assertAgentDay.mockRejectedValue(refused);
    await expect(
      svc.logPast(
        me('staff', Role.USER),
        {
          agenda: 'Review',
          participants: [],
          startedAt: ist('09:00').toISOString(),
          durationMin: 30,
        },
        'LEGACY',
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_BY_BIOMETRIC' });
    expect(repo.createPast).not.toHaveBeenCalled();
  });
});

describe('MeetingsService status meetings (D-20)', () => {
  const STAFF = me('staff', Role.USER);
  const running = (over: Partial<MeetingRecordRow> = {}) =>
    meeting({
      kind: 'STATUS',
      startSource: 'BUTTON',
      confirmedAt: ist('09:00'),
      agenda: '',
      approvalStatus: 'NOT_REQUIRED',
      approverRole: null,
      approverId: null,
      dueAt: null,
      endedAt: null,
      durationSec: null,
      ...over,
    });

  it('starts with only its source: no agenda, no participants, no approver', async () => {
    const { svc, repo, presence, notices } = setup();
    await svc.statusStart(STAFF, 'SUGGESTION', NOW);
    const [input, generation] = repo.startLive.mock.calls[0];
    expect(input).toEqual({
      userId: 'staff',
      date: '2026-10-14',
      agenda: '',
      participants: [],
      approvalStatus: 'NOT_REQUIRED',
      routing: { approverRole: null, approverId: null },
      status: { source: 'SUGGESTION' },
    });
    // Never an implicit day: every caller is held to an open one.
    expect(generation).toBe('AGENT_31');
    expect(presence.broadcast).toHaveBeenCalledWith(
      'staff',
      expect.objectContaining({ type: 'MEETING', note: null }),
      NOW,
    );
    expect(notices()).toHaveLength(0);
  });

  it("4.0: never routed to the department's managers or the organisation admins", async () => {
    const { svc, repo, notices } = setup();
    await svc.statusStart(STAFF, 'BUTTON', NOW);
    // A declared meeting reads the person's department to route it; a status one never does.
    expect((repo.startLive.mock.calls[0][0] as unknown as NewMeeting).routing).toEqual({
      approverRole: null,
      approverId: null,
    });
    expect((repo.startLive.mock.calls[0][0] as unknown as NewMeeting).approvalStatus).toBe(
      'NOT_REQUIRED',
    );
    expect(notices()).toHaveLength(0);
  });

  it.each([['DAY_NOT_STARTED'], ['DAY_ENDED'], ['ON_BREAK'], ['MEETING_IN_PROGRESS']])(
    'is refused with 409 %s',
    async (code) => {
      const { svc, repo } = setup();
      repo.startLive.mockResolvedValueOnce({ ok: false, code } as never);
      await expect(svc.statusStart(STAFF, 'BUTTON', NOW)).rejects.toMatchObject({
        status: 409,
        code,
      });
    },
  );

  it('is refused for biometric staff before anything opens', async () => {
    const { svc, repo, sessions } = setup();
    sessions.assertAgentDay.mockRejectedValue(
      new ConflictError('By the device.', 'ATTENDANCE_BY_BIOMETRIC'),
    );
    await expect(svc.statusStart(STAFF, 'BUTTON', NOW)).rejects.toMatchObject({
      status: 409,
      code: 'ATTENDANCE_BY_BIOMETRIC',
    });
    expect(repo.startLive).not.toHaveBeenCalled();
  });

  it('a forgotten meeting is ended before a new one starts', async () => {
    const { svc, repo } = setup();
    repo.listStatusUnanswered.mockResolvedValueOnce([running()]);
    repo.endStatusUnanswered.mockResolvedValueOnce(running({ endReason: 'NO_ANSWER' }));
    await svc.statusStart(STAFF, 'BUTTON', NOW);
    expect(repo.endStatusUnanswered.mock.invocationCallOrder[0]).toBeLessThan(
      repo.startLive.mock.invocationCallOrder[0],
    );
  });

  it('ends the running meeting through the live end, with no notice', async () => {
    const { svc, repo, notices, presence } = setup();
    const row = running();
    repo.findRunning.mockResolvedValue({
      presenceSessionId: 'ps1',
      startedAt: ist('10:00'),
      record: row,
    });
    repo.findById.mockResolvedValue(row);
    repo.endLive.mockResolvedValue({
      kind: 'ENDED',
      record: running({ endedAt: NOW, durationSec: 3600, endReason: 'USER' }),
    });
    await svc.statusEnd(STAFF, NOW);
    expect(repo.endLive).toHaveBeenCalledWith('m1', 'staff', NOW);
    expect(presence.broadcast).toHaveBeenCalledWith('staff', null, NOW);
    expect(notices()).toHaveLength(0);
  });

  it('ending with nothing running changes nothing (the fallback may have got there first)', async () => {
    const { svc, repo, presence } = setup();
    await svc.statusEnd(STAFF, NOW);
    expect(repo.endLive).not.toHaveBeenCalled();
    expect(presence.endOpen).not.toHaveBeenCalled();
  });

  it('End meeting also ends a meeting started through the older calls', async () => {
    const { svc, repo, presence } = setup();
    repo.findRunning.mockResolvedValue({
      presenceSessionId: 'ps1',
      startedAt: ist('10:00'),
      record: null,
    });
    await svc.statusEnd(STAFF, NOW);
    expect(presence.endOpen).toHaveBeenCalledWith('staff', NOW);
    expect(repo.endLive).not.toHaveBeenCalled();
  });

  it('a late "Still in it" leaves the switch back to Working standing', async () => {
    const { svc, repo } = setup();
    const row = running();
    repo.confirmStatus.mockResolvedValue({ kind: 'TOO_LATE', record: row });
    repo.listStatusUnanswered.mockResolvedValue([row]);
    await svc.statusConfirm(STAFF, NOW);
    expect(repo.endStatusUnanswered).toHaveBeenCalledWith('m1', 'staff', NOW);
  });

  it('a "Still in it" in time ends nothing', async () => {
    const { svc, repo } = setup();
    repo.confirmStatus.mockResolvedValue({ kind: 'CONFIRMED', record: running() });
    await svc.statusConfirm(STAFF, NOW);
    expect(repo.confirmStatus).toHaveBeenCalledWith('staff', NOW);
    expect(repo.endStatusUnanswered).not.toHaveBeenCalled();
  });

  it('the 2 hour check ends each one due, pushes the change and tells nobody else', async () => {
    const { svc, repo, events, presence } = setup();
    repo.listStatusUnanswered.mockResolvedValue([
      running({ id: 'a', userId: 'u1' }),
      running({ id: 'b', userId: 'u2' }),
      running({ id: 'c', userId: 'u3' }),
    ]);
    repo.endStatusUnanswered
      .mockResolvedValueOnce(running({ id: 'a', endReason: 'NO_ANSWER' }))
      // Confirmed a moment ago: the second read under the lock says so.
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('db hiccup'));
    expect(await svc.endUnanswered(NOW)).toBe(1);
    // Anything confirmed at or before 2 h 10 min ago.
    expect(repo.listStatusUnanswered).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 130 * 60_000),
      null,
    );
    expect(presence.broadcast).toHaveBeenCalledTimes(1);
    expect(presence.broadcast).toHaveBeenCalledWith('u1', null, NOW);
    const pushed = events.publish.mock.calls.filter(([n]) => n === WorkdayChangedEvent.eventName);
    expect(pushed).toHaveLength(1);
    expect(pushed[0][1]).toMatchObject({ userIds: ['u1'], reason: 'MEETING' });
    expect(events.publish.mock.calls.filter(([n]) => n === NoticeEvent.eventName)).toHaveLength(0);
  });

  it('every read of a day applies the check for its people first', async () => {
    const { svc, repo } = setup();
    await svc.heal(['staff'], NOW);
    expect(repo.listStatusUnanswered).toHaveBeenCalledWith(expect.any(Date), ['staff']);
    expect(repo.listStatusUnanswered.mock.invocationCallOrder[0]).toBeLessThan(
      repo.heal.mock.invocationCallOrder[0],
    );
  });

  it('old clients read a label as its agenda; new ones the kind, source and end', () => {
    expect(
      meetingView(
        running({ startSource: 'SUGGESTION', endedAt: NOW, durationSec: 60, endReason: 'BREAK' }),
        NOW,
      ),
    ).toMatchObject({
      agenda: 'In a meeting',
      participants: [],
      kind: 'STATUS',
      startSource: 'SUGGESTION',
      confirmedAt: ist('09:00').toISOString(),
      endReason: 'BREAK',
      approvalStatus: 'NOT_REQUIRED',
    });
    expect(meetingView(meeting(), NOW)).toMatchObject({
      agenda: 'Sprint review',
      kind: 'DECLARED',
      startSource: null,
      confirmedAt: null,
      endReason: null,
    });
  });
});
