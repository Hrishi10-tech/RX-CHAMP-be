import { NoticeEvent } from '@shared/events/notice.event';
import { ApprovalsDigestEvent } from '../../domain/events/approvals-digest.event';
import { SlaClaim } from '../../domain/approvals.reader';
import {
  ApprovalsDigestJob,
  ApprovalsSlaJob,
  AutoCloseJob,
  AutoSkipJob,
  HourlyCacheJob,
} from './worktime.jobs';

type Published = [string, unknown];

function bus() {
  return {
    publish: jest.fn(async (_name: string, _payload: unknown) => undefined),
    subscribe: jest.fn(),
  };
}

describe('ApprovalsDigestJob', () => {
  const reader = { digestCounts: jest.fn() };
  const people = { listSuperAdminIds: jest.fn(), findMany: jest.fn() };
  const events = bus();
  const job = new ApprovalsDigestJob(reader as never, people as never, events as never);

  beforeEach(() => jest.clearAllMocks());

  it('sends one digest per approver, expanding the Super Admin pool', async () => {
    reader.digestCounts.mockResolvedValue([
      { approverId: 'mgr', approverRole: 'MANAGER', pending: 3, dueSoon: 1, overdue: 1 },
      { approverId: null, approverRole: 'SUPER_ADMIN', pending: 1, dueSoon: 1, overdue: 0 },
      { approverId: 'sa-1', approverRole: 'SUPER_ADMIN', pending: 3, dueSoon: 0, overdue: 3 },
    ]);
    people.listSuperAdminIds.mockResolvedValue(['sa-1', 'sa-2']);
    people.findMany.mockResolvedValue([{ id: 'mgr' }, { id: 'sa-1' }, { id: 'sa-2' }]);

    const sent = await job.send(new Date('2026-10-13T13:00:00Z'));

    expect(sent).toBe(3);
    const calls = events.publish.mock.calls as Published[];
    expect(calls.every(([name]) => name === ApprovalsDigestEvent.eventName)).toBe(true);
    const byId = Object.fromEntries(
      calls.map(([, e]) => [(e as ApprovalsDigestEvent).recipientId, e as ApprovalsDigestEvent]),
    );
    expect(byId.mgr).toMatchObject({ pending: 3, dueSoon: 1, overdue: 1, date: '2026-10-13' });
    expect(byId['sa-1']).toMatchObject({ pending: 4, dueSoon: 1, overdue: 3 });
    expect(byId['sa-2']).toMatchObject({ pending: 1, dueSoon: 1, overdue: 0 });
  });

  it('skips approvers who are no longer active', async () => {
    reader.digestCounts.mockResolvedValue([
      { approverId: 'gone', approverRole: 'MANAGER', pending: 4, dueSoon: 0, overdue: 0 },
    ]);
    people.findMany.mockResolvedValue([]);
    expect(await job.send(new Date())).toBe(0);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('never throws out of the cron', async () => {
    reader.digestCounts.mockRejectedValue(new Error('db down'));
    await expect(job.run()).resolves.toBeUndefined();
  });
});

describe('ApprovalsSlaJob', () => {
  const reader = {
    remindersDue: jest.fn(),
    escalationsDue: jest.fn(),
    markReminded: jest.fn(),
    markEscalated: jest.fn(),
    fillMissingDueAt: jest.fn(),
  };
  const people = {
    listSuperAdminIds: jest.fn(),
    findMany: jest.fn(),
    findAnyByIds: jest.fn(),
  };
  const settings = { get: jest.fn().mockResolvedValue({ approvalSlaHours: 48 }) };
  const events = bus();
  const job = new ApprovalsSlaJob(
    reader as never,
    people as never,
    events as never,
    settings as never,
  );
  const NOW = new Date('2026-10-14T06:00:00Z');
  let seq = 0;

  const claim = (
    userId: string,
    approverId: string | null,
    over: Partial<SlaClaim> = {},
  ): SlaClaim => ({
    type: 'BREAK',
    id: `${userId}-${(seq += 1)}`,
    userId,
    approverId,
    approverRole: approverId ? 'MANAGER' : 'SUPER_ADMIN',
    ...over,
  });
  const refs = (claims: SlaClaim[]) => claims.map((c) => ({ type: c.type, id: c.id }));

  const notices = () => (events.publish.mock.calls as Published[]).map(([, e]) => e as NoticeEvent);

  beforeEach(() => {
    jest.clearAllMocks();
    events.publish.mockImplementation(async () => undefined);
    people.listSuperAdminIds.mockResolvedValue(['sa-1', 'sa-2']);
    people.findMany.mockImplementation(async ({ ids }: { ids: string[] }) =>
      ids.filter((id) => id !== 'gone').map((id) => ({ id })),
    );
    people.findAnyByIds.mockResolvedValue([{ id: 'mgr', firstName: 'Maya', lastName: 'Reddy' }]);
    reader.remindersDue.mockResolvedValue([]);
    reader.escalationsDue.mockResolvedValue([]);
    reader.markReminded.mockResolvedValue(0);
    reader.markEscalated.mockResolvedValue(0);
    reader.fillMissingDueAt.mockResolvedValue(0);
  });

  it('reminds each approver once with the count due within 12 hours, then marks them', async () => {
    const items = [claim('u1', 'mgr'), claim('u2', 'mgr'), claim('m9', null)];
    reader.remindersDue.mockResolvedValue(items);
    const sent = await job.tick(NOW);
    expect(sent).toBe(3);
    const n = notices();
    const mgr = n.find((e) => e.recipientIds.includes('mgr'))!;
    expect(mgr).toMatchObject({
      type: 'APPROVALS_DUE_SOON',
      title: '2 approvals are due within 12 hours',
    });
    const pool = n.filter(
      (e) => e.recipientIds.includes('sa-1') || e.recipientIds.includes('sa-2'),
    );
    expect(pool.map((e) => e.title)).toEqual([
      '1 approval is due within 12 hours',
      '1 approval is due within 12 hours',
    ]);
    // Marked after the notices, each item once.
    expect(reader.markReminded).toHaveBeenCalledWith(refs(items), NOW);
    expect(events.publish.mock.invocationCallOrder[0]).toBeLessThan(
      reader.markReminded.mock.invocationCallOrder[0],
    );
    expect(reader.escalationsDue).toHaveBeenCalledWith(NOW);
  });

  it('a reminder that fails to go out is not marked, so the next run sends it', async () => {
    const mine = [claim('u1', 'mgr')];
    const pool = [claim('m9', null)];
    reader.remindersDue.mockResolvedValue([...mine, ...pool]);
    events.publish.mockImplementation(async (_name: string, e: unknown) => {
      if ((e as NoticeEvent).recipientIds.includes('mgr')) throw new Error('socket down');
    });
    await job.tick(NOW);
    expect(reader.markReminded).toHaveBeenCalledWith(refs(pool), NOW);
  });

  it('never reminds a Super Admin about their own item in the pool', async () => {
    reader.remindersDue.mockResolvedValue([claim('sa-1', null)]);
    await job.tick(NOW);
    expect(notices().flatMap((e) => e.recipientIds)).toEqual(['sa-2']);
  });

  it('escalates: the approver hears it is overdue, every Super Admin gets one notice naming them', async () => {
    const items = [claim('u1', 'mgr'), claim('u2', 'mgr'), claim('m9', null)];
    reader.escalationsDue.mockResolvedValue(items);
    const sent = await job.tick(NOW);
    const n = notices();
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({
      recipientIds: ['mgr'],
      type: 'APPROVALS_OVERDUE',
      title: '2 approvals are past 48 hours',
    });
    expect(n[1]).toMatchObject({
      recipientIds: ['sa-1', 'sa-2'],
      type: 'APPROVALS_ESCALATED',
      title: '3 approvals are past 48 hours',
      body: 'Waiting on Maya Reddy. Any Super Admin can decide them in Approvals.',
    });
    expect(sent).toBe(3);
    expect(reader.markEscalated).toHaveBeenCalledWith(refs(items), NOW);
  });

  it('an escalation the Super Admins never got is not marked', async () => {
    reader.escalationsDue.mockResolvedValue([claim('u1', 'mgr')]);
    events.publish.mockImplementation(async (_name: string, e: unknown) => {
      if ((e as NoticeEvent).type === 'APPROVALS_ESCALATED') throw new Error('socket down');
    });
    await job.tick(NOW);
    expect(reader.markEscalated).not.toHaveBeenCalled();
  });

  it('sends nothing to people who left, and marks nothing it did not send', async () => {
    reader.remindersDue.mockResolvedValue([claim('u1', 'gone')]);
    expect(await job.tick(NOW)).toBe(0);
    expect(reader.markReminded).not.toHaveBeenCalled();
    reader.remindersDue.mockResolvedValue([]);
    expect(await job.tick(NOW)).toBe(0);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('every run gives waiting items with no due time one (created + SLA)', async () => {
    settings.get.mockResolvedValueOnce({ approvalSlaHours: 24 });
    reader.fillMissingDueAt.mockResolvedValue(2);
    await job.tick(NOW);
    expect(reader.fillMissingDueAt).toHaveBeenCalledWith(24);
  });

  it('never throws out of the cron', async () => {
    reader.remindersDue.mockRejectedValue(new Error('db down'));
    await expect(job.run(NOW)).resolves.toBeUndefined();
  });
});

describe('AutoCloseJob and AutoSkipJob', () => {
  it('run the work, swallow errors, and skip a run that overlaps the previous one', async () => {
    let release: () => void = () => undefined;
    const sessions = {
      autoCloseAll: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const job = new AutoCloseJob(sessions as never);
    const first = job.run(new Date());
    await job.run(new Date());
    expect(sessions.autoCloseAll).toHaveBeenCalledTimes(1);
    release();
    await first;
    sessions.autoCloseAll.mockRejectedValueOnce(new Error('db down'));
    await expect(job.run(new Date())).resolves.toBeUndefined();
    expect(sessions.autoCloseAll).toHaveBeenCalledTimes(2);

    const skips = { autoSkipAll: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(new AutoSkipJob(skips as never).run(new Date())).resolves.toBeUndefined();
    expect(skips.autoSkipAll).toHaveBeenCalledTimes(1);
  });
});

describe('HourlyCacheJob', () => {
  it('warms the settled hour buckets, and never throws', async () => {
    const dayData = { warmSettled: jest.fn().mockResolvedValue(12) };
    const job = new HourlyCacheJob(dayData as never);
    const now = new Date('2026-10-14T21:40:00Z');
    await job.run(now);
    expect(dayData.warmSettled).toHaveBeenCalledWith(now);
    dayData.warmSettled.mockRejectedValueOnce(new Error('db down'));
    await expect(job.run(now)).resolves.toBeUndefined();
  });

  it('schedules no boot run under test', () => {
    const job = new HourlyCacheJob({ warmSettled: jest.fn() } as never);
    const spy = jest.spyOn(global, 'setTimeout');
    job.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    job.onModuleDestroy();
  });
});
