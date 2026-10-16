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
  };
}

describe('EndDayFlow', () => {
  function setup() {
    const order: string[] = [];
    const s = sessions();
    s.findOpen.mockResolvedValue({ id: 's1' });
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
    const skips = {
      saveEndDayComments: jest.fn(async () => {
        order.push('comments');
      }),
      autoSkipFor: jest.fn(async () => {
        order.push('autoSkip');
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

  it('saves comments, checks overdue approvals, materialises skips, checks comments, then closes', async () => {
    const { flow, skips, endDay, order } = setup();
    const comments = [{ breakId: 'b1', comment: 'Client escalation call' }];
    const res = await flow.execute(me, { comments }, 'AGENT_31', NOW);
    expect(order).toEqual(['comments', 'approvalsGate', 'autoSkip', 'commentsGate', 'endDay']);
    expect(skips.saveEndDayComments).toHaveBeenCalledWith(me, comments, NOW);
    expect(skips.autoSkipFor).toHaveBeenCalledWith('u1', NOW, true);
    expect(endDay.finish).toHaveBeenCalledWith('u1', '2026-10-14', NOW);
    expect(res).toEqual({
      ok: true,
      date: '2026-10-14',
      endedAt: NOW.toISOString(),
      workday: VIEW,
    });
  });

  it('a failed gate stops End Day', async () => {
    const { flow, s, workday } = setup();
    workday.assertSkipsCommented.mockRejectedValueOnce(
      new ConflictError('x', 'SKIP_COMMENTS_REQUIRED'),
    );
    await expect(flow.execute(me, {}, 'AGENT_31', NOW)).rejects.toMatchObject({
      code: 'SKIP_COMMENTS_REQUIRED',
    });
    expect(s.endDay).not.toHaveBeenCalled();
  });

  it("a Manager's overdue approvals stop End Day before any open window becomes a skip", async () => {
    const { flow, s, skips, workday } = setup();
    workday.assertNoOverdueApprovals.mockRejectedValueOnce(
      new ConflictError('x', 'APPROVALS_OVERDUE'),
    );
    await expect(flow.execute(me, {}, 'AGENT_31', NOW)).rejects.toMatchObject({
      code: 'APPROVALS_OVERDUE',
    });
    expect(skips.autoSkipFor).not.toHaveBeenCalled();
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
    s.findOpen.mockResolvedValue({ id: 's1' });
    await flow.execute(me, { app: 'Excel' } as never, 'AGENT_31', NOW);
    expect(report.execute).toHaveBeenCalledWith('u1', { app: 'Excel' });
    expect(s.autoCloseIfStale).toHaveBeenCalledWith('u1', NOW);
  });

  it('staff get the ack without their active time; managers see theirs (SPEC 1.8)', async () => {
    const { flow, s, report } = setup();
    s.findOpen.mockResolvedValue({ id: 's1' });
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
