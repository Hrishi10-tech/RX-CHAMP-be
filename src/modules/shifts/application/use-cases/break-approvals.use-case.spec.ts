import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { BreakApprovalsUseCase } from './break-approvals.use-case';
import { BreakRecordRow } from '../../domain/break-record.repository';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const ORG = 'org-a';

/** 4.0 callers: an organisation, and for a Manager the departments they manage. */
const me = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id,
  email: `${id}@x.test`,
  role,
  permissions: [],
  department: null,
  companyId: role === Role.SUPER_ADMIN ? null : ORG,
  status: 'ACTIVE',
  orgId: ORG,
  departmentId: null,
  managedDepartmentIds: role === Role.MANAGER ? ['dept-1'] : [],
  ...over,
});

/** The people behind the records, by id. Unlisted ids are Staff in dept-1 of org-a. */
const SUBJECTS: Record<string, { role: string; companyId: string | null; departmentId: string | null }> = {
  'staff-d2': { role: 'USER', companyId: ORG, departmentId: 'dept-2' },
  'staff-nodept': { role: 'USER', companyId: ORG, departmentId: null },
  'staff-b': { role: 'USER', companyId: 'org-b', departmentId: 'dept-1' },
  mgr: { role: 'MANAGER', companyId: ORG, departmentId: 'dept-1' },
  mgr2: { role: 'MANAGER', companyId: ORG, departmentId: 'dept-1' },
  admin: { role: 'ADMIN', companyId: ORG, departmentId: null },
  sa: { role: 'SUPER_ADMIN', companyId: null, departmentId: null },
};
const subjectOf = (id: string) => ({
  id,
  firstName: id,
  lastName: '',
  email: `${id}@x.test`,
  department: null,
  designation: null,
  managerId: null,
  active: true,
  ...(SUBJECTS[id] ?? { role: 'USER', companyId: ORG, departmentId: 'dept-1' }),
});

function rec(over: Partial<BreakRecordRow> = {}): BreakRecordRow {
  return {
    id: 'r-1',
    userId: 'staff',
    date: '2026-10-13',
    kind: 'MORNING',
    seq: 0,
    presenceType: 'BREAK',
    shiftId: 's',
    shiftName: 'General',
    scheduledStart: new Date('2026-10-13T05:30:00Z'),
    durationMin: 15,
    windowOpen: null,
    windowClose: null,
    ringStart: null,
    ringEnd: null,
    presenceSessionId: 'ps',
    startedAt: new Date('2026-10-13T05:50:00Z'),
    endedAt: new Date('2026-10-13T06:05:00Z'),
    timing: 'LATE',
    minutesOff: 20,
    reason: 'Customer call',
    overrunReason: null,
    source: 'AGENT',
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date('2026-10-13T05:50:00Z'),
    ...over,
  };
}

describe('BreakApprovalsUseCase', () => {
  const records = {
    findById: jest.fn(),
    decide: jest.fn(),
    listApprovals: jest.fn(),
    countApprovals: jest.fn(),
  } as any;
  const people = {
    findById: jest.fn(async (id: string) => subjectOf(id)),
    findAnyByIds: jest.fn(async (ids: string[]) => ids.map(subjectOf)),
  } as any;
  const days = { timezone: 'Asia/Kolkata' } as any;
  const events = { decided: jest.fn(async () => undefined) } as any;
  let useCase: BreakApprovalsUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    records.countApprovals.mockResolvedValue(0);
    records.listApprovals.mockResolvedValue([]);
    useCase = new BreakApprovalsUseCase(records, people, days, events);
  });

  it('keeps staff out', async () => {
    await expect(useCase.list(me('staff', Role.USER), {})).rejects.toMatchObject({ status: 403 });
  });

  it('a Super Admin needs an organisation selected (400 ORG_REQUIRED)', async () => {
    await expect(useCase.list(me('sa', Role.SUPER_ADMIN, { orgId: null }), {})).rejects.toMatchObject({
      status: 400,
      code: 'ORG_REQUIRED',
    });
    await expect(useCase.summary(me('sa', Role.SUPER_ADMIN, { orgId: null }))).rejects.toMatchObject({
      code: 'ORG_REQUIRED',
    });
  });

  it('scopes a Manager to Staff in their departments, whatever the scope', async () => {
    for (const scope of ['all', 'mine'] as const) {
      await useCase.list(me('mgr', Role.MANAGER), { scope, status: 'PENDING', page: 1, limit: 50 });
    }
    for (const call of records.listApprovals.mock.calls) {
      expect(call[0]).toEqual({
        subjects: { companyId: ORG, departmentIds: ['dept-1'], roles: ['USER'] },
        excludeUserId: 'mgr',
        status: ['PENDING'],
        skip: 0,
        take: 50,
      });
    }
    expect(records.countApprovals.mock.calls[0][0]).not.toHaveProperty('skip');
  });

  it("a Manager with no departments lists nobody's items", async () => {
    await useCase.list(me('mgr', Role.MANAGER, { managedDepartmentIds: [] }), {});
    expect(records.listApprovals.mock.calls[0][0].subjects).toEqual({ companyId: ORG, departmentIds: [], roles: ['USER'] });
  });

  it("an Admin's or Super Admin's mine is the Admin pool of the organisation; all is the whole organisation", async () => {
    await useCase.list(me('admin', Role.ADMIN), { scope: 'mine' });
    expect(records.listApprovals.mock.calls[0][0]).toMatchObject({
      subjects: { companyId: ORG },
      adminPool: true,
      excludeUserId: 'admin',
      status: ['PENDING'],
    });

    await useCase.list(me('sa', Role.SUPER_ADMIN), { scope: 'all', status: 'ALL' });
    const all = records.listApprovals.mock.calls[1][0];
    expect(all).toMatchObject({ subjects: { companyId: ORG }, adminPool: false, excludeUserId: 'sa' });
    expect(all.approverId).toBeUndefined();
    expect(all.approverAny).toBeUndefined();
    expect(all.status).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
  });

  it('lists overdue as pending from before today', async () => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date('2026-10-13T08:00:00Z'));
    await useCase.list(me('mgr', Role.MANAGER), { overdue: true, status: 'APPROVED' });
    expect(records.listApprovals.mock.calls[0][0]).toMatchObject({
      status: ['PENDING'],
      beforeDate: '2026-10-13',
    });
    jest.useRealTimers();
  });

  it('summarises the same scope for one day', async () => {
    records.countApprovals.mockResolvedValueOnce(3).mockResolvedValueOnce(1).mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    await expect(useCase.summary(me('mgr', Role.MANAGER), '2026-10-13')).resolves.toEqual({
      date: '2026-10-13',
      pendingToday: 3,
      overdue: 1,
      approvedToday: 5,
      rejectedToday: 0,
    });
    for (const call of records.countApprovals.mock.calls) {
      expect(call[0].subjects).toEqual({ companyId: ORG, departmentIds: ['dept-1'], roles: ['USER'] });
    }
  });

  it("approves Staff in the manager's department and tells the staff member", async () => {
    records.findById.mockResolvedValue(rec());
    records.decide.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    const item = await useCase.approve(me('mgr', Role.MANAGER), 'r-1', '  fine  ');
    expect(records.decide).toHaveBeenCalledWith(
      'r-1',
      ['PENDING'],
      expect.objectContaining({ status: 'APPROVED', decidedById: 'mgr', note: 'fine' }),
    );
    expect(item.approvalStatus).toBe('APPROVED');
    expect(item.user).toMatchObject({ id: 'staff', role: 'USER' });
    expect(events.decided).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-1' }), { id: 'mgr', name: 'mgr' });
  });

  it('any manager of the department may decide; no approverId is needed', async () => {
    records.findById.mockResolvedValue(rec({ approverId: null }));
    records.decide.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'mgr2' }));
    await expect(useCase.approve(me('mgr2', Role.MANAGER), 'r-1')).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
  });

  it('a Manager does not even see items of other departments, Managers, Admins or other organisations (404)', async () => {
    for (const userId of ['staff-d2', 'staff-nodept', 'mgr2', 'admin', 'staff-b']) {
      records.findById.mockResolvedValue(rec({ userId, approverRole: userId === 'staff-d2' ? 'MANAGER' : 'ADMIN' }));
      await expect(useCase.approve(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({ status: 404 });
    }
    expect(records.decide).not.toHaveBeenCalled();
  });

  it("the Admin decides a Manager's break and Staff with no department", async () => {
    records.decide.mockImplementation(async (id: string) => rec({ id, approvalStatus: 'APPROVED', decidedById: 'admin' }));
    for (const userId of ['mgr', 'staff-nodept', 'staff-d2']) {
      records.findById.mockResolvedValue(rec({ userId, approverRole: 'ADMIN' }));
      await expect(useCase.approve(me('admin', Role.ADMIN), 'r-1')).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
    }
    expect(records.decide).toHaveBeenCalledTimes(3);
  });

  it('nobody reaches into another organisation (404), not even a Super Admin acting in this one', async () => {
    records.findById.mockResolvedValue(rec({ userId: 'staff-b' }));
    await expect(useCase.approve(me('admin', Role.ADMIN), 'r-1')).rejects.toMatchObject({ status: 404 });
    await expect(useCase.approve(me('sa', Role.SUPER_ADMIN), 'r-1')).rejects.toMatchObject({ status: 404 });
    // Switched to org-b, the Super Admin can.
    records.decide.mockResolvedValue(rec({ userId: 'staff-b', approvalStatus: 'APPROVED' }));
    await expect(useCase.approve(me('sa', Role.SUPER_ADMIN, { orgId: 'org-b' }), 'r-1')).resolves.toMatchObject({
      approvalStatus: 'APPROVED',
    });
  });

  it('refuses deciding your own break, even as an Admin or a Super Admin (403)', async () => {
    for (const [id, role] of [
      ['sa', Role.SUPER_ADMIN],
      ['admin', Role.ADMIN],
      ['mgr', Role.MANAGER],
    ] as const) {
      records.findById.mockResolvedValue(rec({ userId: id, approverRole: 'ADMIN' }));
      await expect(useCase.approve(me(id, role), 'r-1')).rejects.toMatchObject({ status: 403 });
    }
    expect(records.decide).not.toHaveBeenCalled();
  });

  it('refuses an item that needs no approval or was already decided', async () => {
    records.findById.mockResolvedValue(rec({ approvalStatus: 'NOT_REQUIRED' }));
    await expect(useCase.approve(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      message: 'This break needs no approval.',
    });
    records.findById.mockResolvedValue(rec({ approvalStatus: 'REJECTED' }));
    await expect(useCase.approve(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      message: 'Already rejected.',
    });
  });

  it('answers 404 for an unknown record', async () => {
    records.findById.mockResolvedValue(null);
    await expect(useCase.approve(me('admin', Role.ADMIN), 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('lets only one of two racing approvers win', async () => {
    records.findById.mockResolvedValue(rec());
    records.decide.mockResolvedValue(null);
    await expect(useCase.approve(me('admin', Role.ADMIN), 'r-1')).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
    });
  });

  it('requires a note to reject', async () => {
    await expect(useCase.reject(me('mgr', Role.MANAGER), 'r-1', '   ')).rejects.toMatchObject({
      code: 'NOTE_REQUIRED',
    });
    await expect(useCase.reject(me('mgr', Role.MANAGER), 'r-1', 'no')).rejects.toMatchObject({
      code: 'NOTE_REQUIRED',
    });
  });

  it('approves in bulk and reports what it skipped', async () => {
    records.findById.mockImplementation(async (id: string) =>
      id === 'r-2'
        ? rec({ id, approvalStatus: 'APPROVED' })
        : id === 'r-3'
          ? rec({ id, userId: 'staff-d2' })
          : rec({ id }),
    );
    records.decide.mockImplementation(async (id: string) => rec({ id, approvalStatus: 'APPROVED' }));
    const res = await useCase.bulkApprove(me('mgr', Role.MANAGER), {
      ids: ['r-1', 'r-2', 'r-3', 'r-1'],
    });
    expect(res.approved).toEqual(['r-1']);
    expect(res.skipped).toEqual([
      { id: 'r-2', reason: 'Already approved.' },
      { id: 'r-3', reason: 'Unknown break' },
    ]);
  });

  it('reopens only for the decider or an Admin / Super Admin', async () => {
    records.findById.mockResolvedValue(rec({ approvalStatus: 'REJECTED', decidedById: 'admin' }));
    await expect(useCase.reopen(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({
      status: 403,
    });
    records.decide.mockResolvedValue(rec({ approvalStatus: 'PENDING' }));
    await expect(useCase.reopen(me('sa', Role.SUPER_ADMIN), 'r-1')).resolves.toMatchObject({
      approvalStatus: 'PENDING',
    });
    expect(records.decide).toHaveBeenCalledWith('r-1', ['APPROVED', 'REJECTED'], {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    // The manager who decided it may reopen it.
    records.findById.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    await expect(useCase.reopen(me('mgr', Role.MANAGER), 'r-1')).resolves.toMatchObject({ approvalStatus: 'PENDING' });
    // Another Admin-like caller who did not decide it may too.
    records.findById.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    await expect(useCase.reopen(me('admin', Role.ADMIN), 'r-1')).resolves.toMatchObject({ approvalStatus: 'PENDING' });
  });

  it('reopens only a decided item, within scope', async () => {
    records.findById.mockResolvedValue(rec({ approvalStatus: 'PENDING' }));
    await expect(useCase.reopen(me('admin', Role.ADMIN), 'r-1')).rejects.toMatchObject({ code: 'NOT_DECIDED' });
    records.findById.mockResolvedValue(rec({ userId: 'staff-d2', approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    await expect(useCase.reopen(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({ status: 404 });
    records.findById.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'admin' }));
    records.decide.mockResolvedValue(null);
    await expect(useCase.reopen(me('admin', Role.ADMIN), 'r-1')).rejects.toMatchObject({ code: 'STALE' });
  });

  it("marks in a list which items the caller can decide (never their own or a NOT_REQUIRED one)", async () => {
    records.listApprovals.mockResolvedValue([
      rec({ id: 'a' }),
      rec({ id: 'b', userId: 'mgr', approverRole: 'ADMIN' }),
      rec({ id: 'c', approvalStatus: 'NOT_REQUIRED', approverRole: null }),
      rec({ id: 'd', userId: 'admin', approvalStatus: 'NOT_REQUIRED', approverRole: null }),
    ]);
    const asAdmin = await useCase.list(me('admin', Role.ADMIN), { scope: 'all', status: 'ALL' });
    expect(asAdmin.items.map((i) => [i.id, i.canDecide])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', false],
    ]);
    const asManager = await useCase.list(me('mgr', Role.MANAGER), { status: 'ALL' });
    expect(asManager.items.map((i) => [i.id, i.canDecide])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
      ['d', false],
    ]);
  });
});
