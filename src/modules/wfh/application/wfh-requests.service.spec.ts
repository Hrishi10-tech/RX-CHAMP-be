import { Role } from '@shared/rbac/roles.enum';
import { WfhRequestsService } from './wfh-requests.service';

const NOW = new Date('2026-11-05T06:00:00Z');
const ORG = 'org-a';
// 4.0: the manager of the person's department, acting in their organisation.
const manager = {
  id: 'mgr',
  role: Role.MANAGER,
  companyId: ORG,
  orgId: ORG,
  managedDepartmentIds: ['d1'],
} as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  userId: 'u1',
  kind: 'FULL_DAY',
  part: null,
  startDate: '2026-10-30',
  endDate: '2026-11-02',
  units: 4,
  days: [
    { date: '2026-10-30', units: 2, mask: 3 },
    { date: '2026-11-02', units: 2, mask: 3 },
  ],
  reason: 'Plumber coming',
  status: 'APPROVED',
  approverRole: 'MANAGER',
  approverId: null,
  decidedById: 'mgr',
  decidedAt: NOW,
  decisionNote: null,
  cancelledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const staff = { id: 'u1', role: 'USER', companyId: ORG, departmentId: 'd1', managerId: null };

function setup(locked: string[]) {
  const repo = { lockedMonths: jest.fn(async () => new Set(locked)) };
  const people = {
    any: jest.fn(async () => new Map([['u1', staff]])),
    canSee: jest.fn(() => true),
    waitingFor: jest.fn(async (rows: unknown[]) => rows.map(() => null)),
    shiftTimes: jest.fn(async () => new Map()),
  };
  const svc = new WfhRequestsService(
    repo as never,
    {} as never,
    {} as never,
    people as never,
    {} as never,
    {} as never,
  );
  return { svc, repo };
}

describe('WfhRequestsService.views: taking back (3.6)', () => {
  it('open months: approved work from home can be taken back', async () => {
    const { svc } = setup([]);
    const [view] = await svc.views(manager, [row()] as never, NOW);
    expect(view.can.revoke).toBe(true);
  });

  it('a request touching a locked month cannot: the API would refuse it', async () => {
    const { svc, repo } = setup([`${ORG}|2026-10`]);
    const [view] = await svc.views(manager, [row()] as never, NOW);
    expect(view.can.revoke).toBe(false);
    expect(repo.lockedMonths).toHaveBeenCalledWith([ORG], ['2026-10', '2026-11']);
  });

  it('4.0: a month locked in another organisation changes nothing', async () => {
    const { svc } = setup(['org-b|2026-10']);
    const [view] = await svc.views(manager, [row()] as never, NOW);
    expect(view.can.revoke).toBe(true);
  });
});
