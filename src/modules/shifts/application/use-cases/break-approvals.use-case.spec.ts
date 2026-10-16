import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { BreakApprovalsUseCase } from './break-approvals.use-case';
import { BreakRecordRow } from '../../domain/break-record.repository';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const me = (id: string, role: Role): AuthenticatedUser => ({
  id,
  email: `${id}@x.test`,
  role,
  permissions: [],
  department: null,
  companyId: null,
  status: 'ACTIVE',
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
    approverId: 'mgr',
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
    findById: jest.fn(async (id: string) => ({
      id,
      firstName: id.toUpperCase(),
      lastName: '',
      role: 'MANAGER',
    })),
    findAnyByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        firstName: id,
        lastName: '',
        email: '',
        role: 'USER',
        department: null,
      })),
    ),
  } as any;
  const days = { timezone: 'Asia/Kolkata' } as any;
  const events = { decided: jest.fn(async () => undefined) } as any;
  let useCase: BreakApprovalsUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new BreakApprovalsUseCase(records, people, days, events);
  });

  it('keeps staff out', async () => {
    await expect(useCase.list(me('staff', Role.USER), {})).rejects.toMatchObject({ status: 403 });
  });

  it("scopes a manager to what was routed to them, and a Super Admin's mine to them plus the pool", async () => {
    records.countApprovals.mockResolvedValue(0);
    records.listApprovals.mockResolvedValue([]);
    await useCase.list(me('mgr', Role.MANAGER), {
      scope: 'all',
      status: 'PENDING',
      page: 1,
      limit: 50,
    });
    expect(records.listApprovals.mock.calls[0][0]).toMatchObject({
      approverId: 'mgr',
      status: ['PENDING'],
      skip: 0,
      take: 50,
    });

    await useCase.list(me('sa', Role.SUPER_ADMIN), { scope: 'mine' });
    expect(records.listApprovals.mock.calls[1][0]).toMatchObject({
      approverAny: { approverId: 'sa', approverRole: 'SUPER_ADMIN' },
    });

    await useCase.list(me('sa', Role.SUPER_ADMIN), { scope: 'all', status: 'ALL' });
    const all = records.listApprovals.mock.calls[2][0];
    expect(all.approverAny).toBeUndefined();
    expect(all.approverId).toBeUndefined();
    expect(all.status).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
  });

  it('lists overdue as pending from before today', async () => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date('2026-10-13T08:00:00Z'));
    records.countApprovals.mockResolvedValue(0);
    records.listApprovals.mockResolvedValue([]);
    await useCase.list(me('mgr', Role.MANAGER), { overdue: true, status: 'APPROVED' });
    expect(records.listApprovals.mock.calls[0][0]).toMatchObject({
      status: ['PENDING'],
      beforeDate: '2026-10-13',
    });
    jest.useRealTimers();
  });

  it('approves what was routed to the manager and tells the staff member', async () => {
    records.findById.mockResolvedValue(rec());
    records.decide.mockResolvedValue(rec({ approvalStatus: 'APPROVED', decidedById: 'mgr' }));
    const item = await useCase.approve(me('mgr', Role.MANAGER), 'r-1', '  fine  ');
    expect(records.decide).toHaveBeenCalledWith(
      'r-1',
      ['PENDING'],
      expect.objectContaining({ status: 'APPROVED', decidedById: 'mgr', note: 'fine' }),
    );
    expect(item.approvalStatus).toBe('APPROVED');
    expect(events.decided).toHaveBeenCalled();
  });

  it("refuses a manager deciding someone else's queue", async () => {
    records.findById.mockResolvedValue(rec({ approverId: 'other-mgr' }));
    await expect(useCase.approve(me('mgr', Role.MANAGER), 'r-1')).rejects.toMatchObject({
      status: 403,
    });
    expect(records.decide).not.toHaveBeenCalled();
  });

  it('refuses deciding your own break, even as a Super Admin', async () => {
    records.findById.mockResolvedValue(
      rec({ userId: 'sa', approverRole: 'SUPER_ADMIN', approverId: null }),
    );
    await expect(useCase.approve(me('sa', Role.SUPER_ADMIN), 'r-1')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('lets only one of two racing approvers win', async () => {
    records.findById.mockResolvedValue(rec());
    records.decide.mockResolvedValue(null);
    await expect(useCase.approve(me('sa', Role.SUPER_ADMIN), 'r-1')).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
    });
  });

  it('requires a note to reject', async () => {
    await expect(useCase.reject(me('mgr', Role.MANAGER), 'r-1', '   ')).rejects.toMatchObject({
      code: 'NOTE_REQUIRED',
    });
  });

  it('approves in bulk and reports what it skipped', async () => {
    records.findById.mockImplementation(async (id: string) =>
      id === 'r-2'
        ? rec({ id, approvalStatus: 'APPROVED' })
        : id === 'r-3'
          ? rec({ id, approverId: 'other' })
          : rec({ id }),
    );
    records.decide.mockImplementation(async (id: string) =>
      rec({ id, approvalStatus: 'APPROVED' }),
    );
    const res = await useCase.bulkApprove(me('mgr', Role.MANAGER), {
      ids: ['r-1', 'r-2', 'r-3', 'r-1'],
    });
    expect(res.approved).toEqual(['r-1']);
    expect(res.skipped.map((s) => s.id)).toEqual(['r-2', 'r-3']);
  });

  it('reopens only for the decider or a Super Admin', async () => {
    records.findById.mockResolvedValue(rec({ approvalStatus: 'REJECTED', decidedById: 'sa' }));
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
  });
});
