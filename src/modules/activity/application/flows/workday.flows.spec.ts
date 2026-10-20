import { ConflictError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { EndDayFlow, ReportActivityFlow, StartDayFlow } from './workday.flows';

const me = {
  id: 'u1',
  role: Role.USER,
  email: 'u1@example.test',
  permissions: [],
} as unknown as AuthenticatedUser;
const NOW = new Date('2026-10-14T12:00:00.000Z');
const VIEW = { date: '2026-10-14', state: 'ENDED' };

function sessions() {
  return {
    autoCloseIfStale: jest.fn().mockResolvedValue(false),
    findOpen: jest.fn().mockResolvedValue(null),
    startDay: jest.fn(),
    endDay: jest.fn(),
    openImplicitForSample: jest.fn().mockResolvedValue(null),
    workedAt: jest.fn().mockResolvedValue(false),
    extendAutoClosed: jest.fn().mockResolvedValue(false),
  };
}

describe('EndDayFlow', () => {
  function setup() {
    const order: string[] = [];
    const s = sessions();
    s.findOpen.mockResolvedValue({ id: 's1', startedAt: new Date('2026-10-14T04:00:00.000Z') });
    s.endDay.mockImplementation(async () => {
      order.push('endDay');
      return {
        kind: 'CLOSED',
        date: '2026-10-14',
        endedAt: NOW,
        newlyEnded: true,
        session: { id: 's1' },
      };
    });
    const PLANNED = [{ record: { id: 'planned-lunch', approvalStatus: 'PENDING' } }];
    const skips = {
      planAutoSkipsFor: jest.fn(async () => {
        order.push('planSkips');
        return PLANNED;
      }),
      checkEndDayComments: jest.fn(async (_me: unknown, c: { breakId: string }[]) => {
        order.push('checkComments');
        return c.map((x) => ({ id: x.breakId, text: 'ok' }));
      }),
      plannedNeedingComment: jest.fn(async () => [{ id: 'planned-lunch' }]),
      createPlanned: jest.fn(async () => {
        order.push('createSkips');
      }),
      writeEndDayComments: jest.fn(async () => {
        order.push('writeComments');
      }),
    };
    const workday = {
      assertNoOverdueApprovals: jest.fn(async () => {
        order.push('approvalsGate');
      }),
      assertSkipsCommented: jest.fn(async () => {
        order.push('commentsGate');
      }),
      view: jest.fn().mockResolvedValue(VIEW),
    };
    const endDay = { finish: jest.fn().mockResolvedValue(undefined) };
    const flow = new EndDayFlow(s as never, skips as never, workday as never, endDay as never);
    return { flow, s, skips, workday, endDay, order };
  }

  it('judges everything first (comments, overdue approvals, the comment gate with the planned skips), then writes and closes', async () => {
    const { flow, skips, workday, endDay, order } = setup();
    const comments = [{ breakId: 'b1', comment: 'Client escalation call' }];
    const res = await flow.execute(me, { comments }, 'AGENT_31', NOW);
    expect(order).toEqual([
      'planSkips',
      'checkComments',
      'approvalsGate',
      'commentsGate',
      'createSkips',
      'writeComments',
      'endDay',
    ]);
    expect(skips.planAutoSkipsFor).toHaveBeenCalledWith('u1', NOW, true);
    expect(skips.checkEndDayComments).toHaveBeenCalledWith(me, comments, [
      { record: { id: 'planned-lunch', approvalStatus: 'PENDING' } },
    ]);
    // The gate sees the auto-skips this End Day would create and the comments sent with it.
    expect(workday.assertSkipsCommented).toHaveBeenCalledWith(
      me,
      NOW,
      [{ id: 'planned-lunch' }],
      new Set(['b1']),
    );
    expect(endDay.finish).toHaveBeenCalledWith('u1', '2026-10-14', NOW);
    expect(res).toEqual({
      ok: true,
      date: '2026-10-14',
      endedAt: NOW.toISOString(),
      workday: VIEW,
    });
  });

  it('a refused End Day writes nothing: no auto-skip, no comment, no End Day (re-audit M1)', async () => {
    for (const [gate, code] of [
      ['assertSkipsCommented', 'SKIP_COMMENTS_REQUIRED'],
      ['assertNoOverdueApprovals', 'APPROVALS_OVERDUE'],
    ] as const) {
      const { flow, s, skips, workday } = setup();
      workday[gate].mockRejectedValueOnce(new ConflictError('x', code));
      await expect(
        flow.execute(me, { comments: [{ breakId: 'b1', comment: 'x' }] }, 'AGENT_31', NOW),
      ).rejects.toMatchObject({ code });
      expect(skips.createPlanned).not.toHaveBeenCalled();
      expect(skips.writeEndDayComments).not.toHaveBeenCalled();
      expect(s.endDay).not.toHaveBeenCalled();
    }
    // A bad comment too.
    const { flow, s, skips } = setup();
    skips.checkEndDayComments.mockRejectedValueOnce(new ConflictError('x', 'COMMENT_INVALID'));
    await expect(flow.execute(me, {}, 'AGENT_31', NOW)).rejects.toMatchObject({
      code: 'COMMENT_INVALID',
    });
    expect(skips.createPlanned).not.toHaveBeenCalled();
    expect(s.endDay).not.toHaveBeenCalled();
  });

  it('an End Day older than the open session start is refused (re-audit L3)', async () => {
    const { flow, s, skips } = setup();
    s.findOpen.mockResolvedValue({ id: 's1', startedAt: new Date(NOW.getTime() + 60_000) });
    await expect(flow.execute(me, {}, 'AGENT_31', NOW)).rejects.toMatchObject({
      status: 422,
      code: 'EVENT_TIME_INVALID',
    });
    expect(skips.createPlanned).not.toHaveBeenCalled();
    expect(s.endDay).not.toHaveBeenCalled();
  });

  it('older agents are never gated', async () => {
    const { flow, s, workday } = setup();
    await flow.execute(me, {}, 'LEGACY', NOW);
    expect(workday.assertNoOverdueApprovals).not.toHaveBeenCalled();
    expect(workday.assertSkipsCommented).not.toHaveBeenCalled();
    expect(s.endDay).toHaveBeenCalledWith('u1', 'LEGACY', NOW);
  });

  it('an ended day answers as it is: no gates, no second finish', async () => {
    const { flow, s, workday, endDay } = setup();
    s.findOpen.mockResolvedValue(null);
    s.endDay.mockResolvedValue({ kind: 'ALREADY_ENDED', date: '2026-10-14', endedAt: NOW });
    const res = await flow.execute(me, {}, 'AGENT_31', NOW);
    expect(workday.assertNoOverdueApprovals).not.toHaveBeenCalled();
    expect(workday.assertSkipsCommented).not.toHaveBeenCalled();
    expect(endDay.finish).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('a 3.1 agent with nothing started gets 409 DAY_NOT_STARTED', async () => {
    const { flow, s, endDay } = setup();
    s.findOpen.mockResolvedValue(null);
    s.endDay.mockResolvedValue({ kind: 'NOT_STARTED', date: '2026-10-14' });
    await expect(flow.execute(me, {}, 'AGENT_31', NOW)).rejects.toMatchObject({
      status: 409,
      code: 'DAY_NOT_STARTED',
    });
    expect(endDay.finish).not.toHaveBeenCalled();
  });

  it('answers with the day that was ended, not the next one (after midnight, after a night shift)', async () => {
    const { flow, s, workday } = setup();
    s.endDay.mockResolvedValue({
      kind: 'CLOSED',
      date: '2026-10-13',
      endedAt: NOW,
      newlyEnded: true,
      session: { id: 's1' },
    });
    await flow.execute(me, {}, 'AGENT_31', NOW);
    expect(workday.view).toHaveBeenLastCalledWith(me, NOW, '2026-10-13');
    s.findOpen.mockResolvedValue(null);
    s.endDay.mockResolvedValue({ kind: 'ALREADY_ENDED', date: '2026-10-13', endedAt: NOW });
    await flow.execute(me, {}, 'AGENT_31', NOW);
    expect(workday.view).toHaveBeenLastCalledWith(me, NOW, '2026-10-13');
    // A legacy End Day with nothing open marks today, as in 3.0.
    s.endDay.mockResolvedValue({
      kind: 'MARKED',
      date: '2026-10-14',
      endedAt: NOW,
      newlyEnded: true,
    });
    await flow.execute(me, {}, 'LEGACY', NOW);
    expect(workday.view).toHaveBeenLastCalledWith(me, NOW, undefined);
  });

  it('a session closed but the day already marked ended does not finish twice', async () => {
    const { flow, s, endDay } = setup();
    s.endDay.mockResolvedValue({
      kind: 'CLOSED',
      date: '2026-10-14',
      endedAt: NOW,
      newlyEnded: false,
      session: {},
    });
    await flow.execute(me, {}, 'AGENT_31', NOW);
    expect(endDay.finish).not.toHaveBeenCalled();
  });
});

describe('StartDayFlow', () => {
  function setup() {
    const s = sessions();
    const workday = { view: jest.fn().mockResolvedValue({ state: 'OPEN' }) };
    const startDay = { announce: jest.fn().mockResolvedValue(undefined) };
    const presence = { broadcast: jest.fn().mockResolvedValue(undefined) };
    const flow = new StartDayFlow(
      s as never,
      workday as never,
      startDay as never,
      presence as never,
    );
    return { flow, s, startDay, presence };
  }

  it('opens the day, announces it, and accepts a start up to 10 minutes back', async () => {
    const { flow, s, startDay, presence } = setup();
    s.startDay.mockResolvedValue({ opened: true, resumed: true, session: { date: '2026-10-14' } });
    const startedAt = new Date(NOW.getTime() - 9 * 60_000).toISOString();
    const res = await flow.execute(me, { startedAt }, 'AGENT_31', NOW);
    expect(s.startDay).toHaveBeenCalledWith('u1', new Date(startedAt), 'AGENT_31', NOW);
    expect(startDay.announce).toHaveBeenCalledWith('u1', '2026-10-14', NOW);
    expect(presence.broadcast).toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: true,
      date: '2026-10-14',
      resumed: true,
      workday: { state: 'OPEN' },
    });
  });

  it('never trusts an older or future start, and repeats quietly when already open', async () => {
    const { flow, s, startDay } = setup();
    s.startDay.mockResolvedValue({
      opened: false,
      resumed: false,
      session: { date: '2026-10-14' },
    });
    await flow.execute(
      me,
      { startedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() },
      'AGENT_31',
      NOW,
    );
    expect(s.startDay).toHaveBeenLastCalledWith('u1', NOW, 'AGENT_31', NOW);
    await flow.execute(
      me,
      { startedAt: new Date(NOW.getTime() + 60_000).toISOString() },
      'AGENT_31',
      NOW,
    );
    expect(s.startDay).toHaveBeenLastCalledWith('u1', NOW, 'AGENT_31', NOW);
    expect(startDay.announce).not.toHaveBeenCalled();
  });
});

describe('ReportActivityFlow', () => {
  function setup() {
    const s = sessions();
    const report = {
      execute: jest.fn().mockResolvedValue({ ok: true, shouldCapture: true }),
      ackWithoutStoring: jest.fn().mockResolvedValue({ ok: true, shouldCapture: false }),
    };
    const flow = new ReportActivityFlow(s as never, report as never);
    return { flow, s, report };
  }

  it('a 3.1 agent with no open session stores nothing and is told not to capture', async () => {
    const { flow, s, report } = setup();
    const ack = await flow.execute(me, { app: 'Excel', idle: false } as never, 'AGENT_31', NOW);
    expect(ack).toMatchObject({ shouldCapture: false });
    expect(report.execute).not.toHaveBeenCalled();
    expect(s.openImplicitForSample).not.toHaveBeenCalled();
  });

  it('a sample taken during a work session that has closed since (an offline backlog) is stored as late', async () => {
    const { flow, s, report } = setup();
    s.workedAt.mockResolvedValue(true);
    const body = { at: '2026-10-12T05:00:00.000Z', app: 'Excel', idle: false };
    await flow.execute(me, body as never, 'AGENT_31', NOW);
    expect(s.workedAt).toHaveBeenCalledWith('u1', new Date('2026-10-12T05:00:00.000Z'));
    expect(report.execute).toHaveBeenCalledWith('u1', body, { late: true });
    expect(report.ackWithoutStoring).not.toHaveBeenCalled();
    expect(s.openImplicitForSample).not.toHaveBeenCalled();
  });

  it('a late input after the server auto-closed the day (before its latest end) moves the close and is stored', async () => {
    const { flow, s, report } = setup();
    s.extendAutoClosed.mockResolvedValue(true);
    const body = { at: '2026-10-12T05:00:00.000Z', app: 'Excel', idle: false };
    await flow.execute(me, body as never, 'AGENT_31', NOW, true);
    expect(s.extendAutoClosed).toHaveBeenCalledWith('u1', new Date('2026-10-12T05:00:00.000Z'));
    expect(report.execute).toHaveBeenCalledWith('u1', body, { late: true });
  });

  it('only a 4.x agent may move a close (re-audit M5): a 3.1 agent never does', async () => {
    const { flow, s, report } = setup();
    s.extendAutoClosed.mockResolvedValue(true);
    const body = { at: '2026-10-12T05:00:00.000Z', app: 'Excel', idle: false };
    await flow.execute(me, body as never, 'AGENT_31', NOW, false);
    expect(s.extendAutoClosed).not.toHaveBeenCalled();
    expect(report.execute).not.toHaveBeenCalled();
    expect(report.ackWithoutStoring).toHaveBeenCalledWith('u1', NOW);
  });

  describe("a backlog that arrives while today's session is open (re-audit H2)", () => {
    const today = { id: 's-today', startedAt: new Date('2026-10-14T04:00:00.000Z') };
    const yesterday = { at: '2026-10-13T06:00:00.000Z', app: 'Excel', idle: false };

    it('a sample inside a closed session of an earlier day is stored as late', async () => {
      const { flow, s, report } = setup();
      s.findOpen.mockResolvedValue(today);
      s.workedAt.mockResolvedValue(true);
      await flow.execute(me, yesterday as never, 'AGENT_31', NOW, true);
      expect(s.workedAt).toHaveBeenCalledWith('u1', new Date(yesterday.at));
      expect(report.execute).toHaveBeenCalledWith('u1', yesterday, { late: true });
    });

    it('a later input of a day the server auto-closed moves the close (4.x) and is stored as late', async () => {
      const { flow, s, report } = setup();
      s.findOpen.mockResolvedValue(today);
      s.extendAutoClosed.mockResolvedValue(true);
      await flow.execute(me, yesterday as never, 'AGENT_31', NOW, true);
      expect(s.extendAutoClosed).toHaveBeenCalledWith('u1', new Date(yesterday.at));
      expect(report.execute).toHaveBeenCalledWith('u1', yesterday, { late: true });
    });

    it('anything else before the open session reports as before (its day decides), never dropped silently here', async () => {
      const { flow, s, report } = setup();
      s.findOpen.mockResolvedValue(today);
      await flow.execute(me, yesterday as never, 'AGENT_31', NOW, true);
      expect(report.execute).toHaveBeenCalledWith('u1', yesterday);
      expect(report.ackWithoutStoring).not.toHaveBeenCalled();
    });

    it('a sample inside the open session never takes the late path', async () => {
      const { flow, s, report } = setup();
      s.findOpen.mockResolvedValue(today);
      const now = { at: '2026-10-14T11:59:00.000Z', app: 'Excel' };
      await flow.execute(me, now as never, 'AGENT_31', NOW, true);
      expect(s.workedAt).not.toHaveBeenCalled();
      expect(s.extendAutoClosed).not.toHaveBeenCalled();
      expect(report.execute).toHaveBeenCalledWith('u1', now);
    });
  });

  it('an idle or locked late sample never moves a close', async () => {
    const { flow, s, report } = setup();
    s.extendAutoClosed.mockResolvedValue(true);
    await flow.execute(
      me,
      { at: '2026-10-12T05:00:00.000Z', idle: true } as never,
      'AGENT_31',
      NOW,
    );
    await flow.execute(
      me,
      { at: '2026-10-12T05:01:00.000Z', locked: true } as never,
      'AGENT_31',
      NOW,
    );
    await flow.execute(
      me,
      { at: '2026-10-12T05:02:00.000Z', app: 'LockApp.exe' } as never,
      'AGENT_31',
      NOW,
    );
    expect(s.extendAutoClosed).not.toHaveBeenCalled();
    expect(report.execute).not.toHaveBeenCalled();
    expect(report.ackWithoutStoring).toHaveBeenCalledTimes(3);
  });

  it('a sample outside every work session is still not stored', async () => {
    const { flow, s, report } = setup();
    await flow.execute(
      me,
      { at: '2026-10-12T05:00:00.000Z', app: 'Excel' } as never,
      'AGENT_31',
      NOW,
    );
    expect(s.workedAt).toHaveBeenCalled();
    expect(report.execute).not.toHaveBeenCalled();
    expect(report.ackWithoutStoring).toHaveBeenCalledWith('u1', NOW);
  });

  it("an older agent's first active sample opens the day implicitly", async () => {
    const { flow, s, report } = setup();
    await flow.execute(me, { app: 'Excel', idle: false } as never, 'LEGACY', NOW);
    expect(s.openImplicitForSample).toHaveBeenCalledWith('u1', NOW, NOW);
    expect(report.execute).toHaveBeenCalled();
  });

  it('an idle, locked or lock-screen sample never opens the day', async () => {
    const { flow, s, report } = setup();
    await flow.execute(me, { app: 'Excel', idle: true } as never, 'LEGACY', NOW);
    await flow.execute(me, { app: 'Excel', locked: true } as never, 'LEGACY', NOW);
    await flow.execute(me, { app: 'LockApp.exe' } as never, 'LEGACY', NOW);
    expect(s.openImplicitForSample).not.toHaveBeenCalled();
    expect(report.execute).toHaveBeenCalledTimes(3);
  });

  it('with a session open, every agent reports as before', async () => {
    const { flow, s, report } = setup();
    s.findOpen.mockResolvedValue({ id: 's1', startedAt: new Date('2026-10-14T04:00:00.000Z') });
    await flow.execute(me, { app: 'Excel' } as never, 'AGENT_31', NOW);
    expect(report.execute).toHaveBeenCalledWith('u1', { app: 'Excel' });
    expect(s.autoCloseIfStale).toHaveBeenCalledWith('u1', NOW);
  });

  it('staff get the ack without their active time; managers see theirs (SPEC 1.8)', async () => {
    const { flow, s, report } = setup();
    s.findOpen.mockResolvedValue({ id: 's1', startedAt: new Date('2026-10-14T04:00:00.000Z') });
    const full = {
      ok: true,
      activeSec: 5400,
      workingBasisSec: 32400,
      remainingSec: 27000,
      clockedOut: false,
      dayEnded: false,
      shouldCapture: true,
      screenshotsEnabled: true,
    };
    report.execute.mockResolvedValue(full);
    expect(await flow.execute(me, { app: 'Excel' } as never, 'AGENT_31', NOW)).toEqual({
      ...full,
      activeSec: 0,
      remainingSec: 32400,
    });
    const mgr = { ...me, role: Role.MANAGER } as AuthenticatedUser;
    expect(await flow.execute(mgr, { app: 'Excel' } as never, 'AGENT_31', NOW)).toEqual(full);
    // Not stored (no session) is redacted the same way.
    s.findOpen.mockResolvedValue(null);
    report.ackWithoutStoring.mockResolvedValue({ ...full, shouldCapture: false });
    expect(await flow.execute(me, {} as never, 'AGENT_31', NOW)).toMatchObject({
      activeSec: 0,
      shouldCapture: false,
    });
  });
});
