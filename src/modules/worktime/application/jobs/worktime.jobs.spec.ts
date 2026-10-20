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

/**
 * 4.0 people behind approvals (docs/4.0/SPEC.md 1.3): two organisations, each with
 * an Admin; co-1 has dept-1 with two managers and dept-empty with none.
 */
const ADMINS: Record<string, string[]> = {
  'co-1': ['admin-1'],
  'co-2': ['admin-2'],
  'co-noadmin': [],
};
const MANAGERS: Record<string, string[]> = {
  'dept-1': ['mgr', 'mgr-b'],
  'dept-2': ['mgr-2'],
  'dept-empty': [],
};

function peopleReader() {
  return {
    listOrgAdminIds: jest.fn(async (companyId: string) => ADMINS[companyId] ?? []),
    listDepartmentManagerIds: jest.fn(async (departmentId: string) => MANAGERS[departmentId] ?? []),
    findMany: jest.fn(async ({ ids }: { ids: string[] }) =>
      ids.filter((id) => id !== 'gone').map((id) => ({ id })),
    ),
    findAnyByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        firstName: id === 'mgr' ? 'Maya' : id === 'mgr-b' ? 'Arjun' : id,
        lastName: id === 'mgr' || id === 'mgr-b' ? 'Reddy' : '',
      })),
    ),
    listSuperAdminIds: jest.fn(async () => ['sa-1']),
  };
}

describe('ApprovalsDigestJob', () => {
  const reader = { digestCounts: jest.fn() };
  const people = peopleReader();
  const events = bus();
  const job = new ApprovalsDigestJob(reader as never, people as never, events as never);
  const digests = () =>
    Object.fromEntries(
      (events.publish.mock.calls as Published[]).map(([, e]) => [
        (e as ApprovalsDigestEvent).recipientId,
        e as ApprovalsDigestEvent,
      ]),
    );
  const row = (over: Record<string, unknown>) => ({
    approverId: null,
    approverRole: 'MANAGER',
    companyId: 'co-1',
    departmentId: 'dept-1',
    pending: 1,
    dueSoon: 0,
    overdue: 0,
    ...over,
  });

  beforeEach(() => jest.clearAllMocks());

  it("sends one digest per approver: MANAGER items to the department's managers, ADMIN items to the organisation's Admin", async () => {
    reader.digestCounts.mockResolvedValue([
      row({ pending: 3, dueSoon: 1, overdue: 1 }),
      row({ approverRole: 'ADMIN', departmentId: null, pending: 2, overdue: 2 }),
      row({ companyId: 'co-2', departmentId: 'dept-2', pending: 1, dueSoon: 1 }),
    ]);

    const sent = await job.send(new Date('2026-10-13T13:00:00Z'));

    expect(sent).toBe(4);
    const calls = events.publish.mock.calls as Published[];
    expect(calls.every(([name]) => name === ApprovalsDigestEvent.eventName)).toBe(true);
    const byId = digests();
    expect(byId.mgr).toMatchObject({ pending: 3, dueSoon: 1, overdue: 1, date: '2026-10-13' });
    expect(byId['mgr-b']).toMatchObject({ pending: 3, dueSoon: 1, overdue: 1 });
    expect(byId['admin-1']).toMatchObject({ pending: 2, dueSoon: 0, overdue: 2 });
    expect(byId['mgr-2']).toMatchObject({ pending: 1, dueSoon: 1 });
    // Never across organisations; Super Admins are not in the digest.
    expect(byId['admin-2']).toBeUndefined();
    expect(byId['sa-1']).toBeUndefined();
    expect(people.listOrgAdminIds).not.toHaveBeenCalledWith('co-2');
  });

  it("a department without managers falls back to the organisation's Admin; 3.x Super Admin rows go to the Admin too", async () => {
    reader.digestCounts.mockResolvedValue([
      row({ departmentId: 'dept-empty', pending: 2 }),
      row({ departmentId: null, pending: 1, dueSoon: 1 }),
      row({ approverRole: 'SUPER_ADMIN', departmentId: null, pending: 1, overdue: 1 }),
    ]);
    expect(await job.send(new Date('2026-10-13T13:00:00Z'))).toBe(1);
    expect(digests()['admin-1']).toMatchObject({ pending: 4, dueSoon: 1, overdue: 1 });
    // Looked up once per run.
    expect(people.listOrgAdminIds).toHaveBeenCalledTimes(1);
  });

  it('items outside any organisation, or in one without an Admin, reach nobody', async () => {
    reader.digestCounts.mockResolvedValue([
      row({ approverRole: 'ADMIN', companyId: null, departmentId: null, pending: 2 }),
      row({ approverRole: 'ADMIN', companyId: 'co-noadmin', departmentId: null, pending: 2 }),
    ]);
    expect(await job.send(new Date())).toBe(0);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('skips approvers who are no longer active', async () => {
    reader.digestCounts.mockResolvedValue([row({ departmentId: 'dept-gone', pending: 4 })]);
    people.listDepartmentManagerIds.mockResolvedValueOnce(['gone']);
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
  const people = peopleReader();
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

  /** A Staff item of dept-1 in co-1 (MANAGER) unless told otherwise. */
  const claim = (userId: string, over: Partial<SlaClaim> = {}): SlaClaim => ({
    type: 'BREAK',
    id: `${userId}-${(seq += 1)}`,
    userId,
    approverId: null,
    approverRole: 'MANAGER',
    companyId: 'co-1',
    departmentId: 'dept-1',
    ...over,
  });
  /** An item waiting for the Admin (a Manager's, or Staff with no department). */
  const adminItem = (userId: string, over: Partial<SlaClaim> = {}) =>
    claim(userId, { approverRole: 'ADMIN', departmentId: null, ...over });
  const refs = (claims: SlaClaim[]) => claims.map((c) => ({ type: c.type, id: c.id }));

  const notices = () => (events.publish.mock.calls as Published[]).map(([, e]) => e as NoticeEvent);

  beforeEach(() => {
    jest.clearAllMocks();
    events.publish.mockImplementation(async () => undefined);
    reader.remindersDue.mockResolvedValue([]);
    reader.escalationsDue.mockResolvedValue([]);
    reader.markReminded.mockResolvedValue(0);
    reader.markEscalated.mockResolvedValue(0);
    reader.fillMissingDueAt.mockResolvedValue(0);
  });

  it("reminds each approver once: the department's managers for MANAGER items, the Admin for ADMIN items", async () => {
    const items = [
      claim('u1'),
      claim('u2'),
      adminItem('m9'),
      claim('u3', { companyId: 'co-2', departmentId: 'dept-2' }),
    ];
    reader.remindersDue.mockResolvedValue(items);
    const sent = await job.tick(NOW);
    const to = (id: string) => notices().filter((e) => e.recipientIds.includes(id));
    expect(to('mgr')).toEqual([
      expect.objectContaining({
        type: 'APPROVALS_DUE_SOON',
        title: '2 approvals are due within 12 hours',
      }),
    ]);
    expect(to('mgr-b').map((e) => e.title)).toEqual(['2 approvals are due within 12 hours']);
    expect(to('admin-1').map((e) => e.title)).toEqual(['1 approval is due within 12 hours']);
    expect(to('mgr-2').map((e) => e.title)).toEqual(['1 approval is due within 12 hours']);
    // Never across organisations, never to Super Admins.
    expect(to('admin-2')).toEqual([]);
    expect(to('sa-1')).toEqual([]);
    expect(sent).toBe(4);
    // Marked after the notices, each item once.
    expect(reader.markReminded).toHaveBeenCalledWith(refs(items), NOW);
    expect(events.publish.mock.invocationCallOrder[0]).toBeLessThan(
      reader.markReminded.mock.invocationCallOrder[0],
    );
    expect(reader.escalationsDue).toHaveBeenCalledWith(NOW);
  });

  it("a department without managers is reminded through the organisation's Admin", async () => {
    reader.remindersDue.mockResolvedValue([
      claim('u1', { departmentId: 'dept-empty' }),
      claim('u2', { departmentId: null }),
    ]);
    await job.tick(NOW);
    expect(notices()).toEqual([
      expect.objectContaining({
        recipientIds: ['admin-1'],
        title: '2 approvals are due within 12 hours',
      }),
    ]);
  });

  it('a reminder counts once any approver got it; one nobody got is not marked, so the next run sends it', async () => {
    const dept = [claim('u1')];
    const theAdmins = [adminItem('m9')];
    reader.remindersDue.mockResolvedValue([...dept, ...theAdmins]);
    events.publish.mockImplementation(async (_name: string, e: unknown) => {
      const ids = (e as NoticeEvent).recipientIds;
      if (ids.includes('mgr') || ids.includes('admin-1')) throw new Error('socket down');
    });
    await job.tick(NOW);
    // mgr-b got the dept-1 reminder; the Admin's never went out.
    expect(reader.markReminded).toHaveBeenCalledWith(refs(dept), NOW);
  });

  it('never reminds anyone about their own item', async () => {
    reader.remindersDue.mockResolvedValue([adminItem('admin-1'), claim('mgr')]);
    await job.tick(NOW);
    expect(notices().flatMap((e) => e.recipientIds)).toEqual(['mgr-b']);
  });

  it("escalates: the department's managers hear it is overdue, the organisation's Admin gets one notice naming them", async () => {
    const items = [claim('u1'), claim('u2'), adminItem('m9')];
    reader.escalationsDue.mockResolvedValue(items);
    const sent = await job.tick(NOW);
    const n = notices();
    expect(n).toHaveLength(3);
    expect(n.filter((e) => e.type === 'APPROVALS_OVERDUE')).toEqual([
      expect.objectContaining({ recipientIds: ['mgr'], title: '2 approvals are past 48 hours' }),
      expect.objectContaining({ recipientIds: ['mgr-b'], title: '2 approvals are past 48 hours' }),
    ]);
    expect(n.find((e) => e.type === 'APPROVALS_ESCALATED')).toMatchObject({
      recipientIds: ['admin-1'],
      title: '3 approvals are past 48 hours',
      body: expect.stringContaining('Waiting on Maya Reddy and Arjun Reddy.'),
    });
    expect(sent).toBe(3);
    expect(reader.markEscalated).toHaveBeenCalledWith(refs(items), NOW);
  });

  it('escalates per organisation, never across', async () => {
    const one = [claim('u1')];
    const two = [claim('u5', { companyId: 'co-2', departmentId: 'dept-2' })];
    reader.escalationsDue.mockResolvedValue([...one, ...two]);
    await job.tick(NOW);
    const escalations = notices().filter((e) => e.type === 'APPROVALS_ESCALATED');
    expect(escalations).toEqual([
      expect.objectContaining({ recipientIds: ['admin-1'], title: '1 approval is past 48 hours' }),
      expect.objectContaining({ recipientIds: ['admin-2'], title: '1 approval is past 48 hours' }),
    ]);
    expect(escalations[1].body).toContain('mgr-2');
    expect(escalations[1].body).not.toContain('Maya');
  });

  it("names each organisation's own SLA hours", async () => {
    settings.get.mockImplementation(async (companyId?: string | null) => ({
      approvalSlaHours: companyId === 'co-2' ? 24 : 48,
    }));
    reader.escalationsDue.mockResolvedValue([
      claim('u1'),
      claim('u5', { companyId: 'co-2', departmentId: 'dept-2' }),
    ]);
    await job.tick(NOW);
    const titles = notices()
      .filter((e) => e.type === 'APPROVALS_ESCALATED')
      .map((e) => [e.recipientIds[0], e.title]);
    expect(titles).toEqual([
      ['admin-1', '1 approval is past 48 hours'],
      ['admin-2', '1 approval is past 24 hours'],
    ]);
    settings.get.mockResolvedValue({ approvalSlaHours: 48 });
  });

  it('an escalation the Admin never got is not marked', async () => {
    reader.escalationsDue.mockResolvedValue([claim('u1')]);
    events.publish.mockImplementation(async (_name: string, e: unknown) => {
      if ((e as NoticeEvent).type === 'APPROVALS_ESCALATED') throw new Error('socket down');
    });
    await job.tick(NOW);
    expect(reader.markEscalated).not.toHaveBeenCalled();
  });

  it('in an organisation without an Admin, only the items whose managers were told are marked', async () => {
    const told = claim('u1', { companyId: 'co-noadmin', departmentId: 'dept-1' });
    const nobody = adminItem('u2', { companyId: 'co-noadmin' });
    reader.escalationsDue.mockResolvedValue([told, nobody]);
    await job.tick(NOW);
    expect(notices().map((e) => e.type)).toEqual(['APPROVALS_OVERDUE', 'APPROVALS_OVERDUE']);
    expect(reader.markEscalated).toHaveBeenCalledWith(refs([told]), NOW);
  });

  it('sends nothing to people who left, and marks nothing it did not send', async () => {
    people.listDepartmentManagerIds.mockResolvedValueOnce(['gone']);
    reader.remindersDue.mockResolvedValue([claim('u1', { departmentId: 'dept-gone' })]);
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
    const breakRecords = { endExpiredPaused: jest.fn().mockResolvedValue(0) };
    await expect(
      new AutoSkipJob(skips as never, breakRecords as never).run(new Date()),
    ).resolves.toBeUndefined();
    expect(skips.autoSkipAll).toHaveBeenCalledTimes(1);
  });

  it('the auto-skip run also ends paused breaks whose window closed (4.0)', async () => {
    const skips = { autoSkipAll: jest.fn().mockResolvedValue(0) };
    const breakRecords = { endExpiredPaused: jest.fn().mockResolvedValue(2) };
    const now = new Date('2026-10-14T09:00:00Z');
    await new AutoSkipJob(skips as never, breakRecords as never).run(now);
    expect(skips.autoSkipAll).toHaveBeenCalledWith(now);
    expect(breakRecords.endExpiredPaused).toHaveBeenCalledWith(now);
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
