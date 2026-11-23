import {
  FormerPlacement,
  UserAccessChange,
  UserAccessChangedEvent,
} from '@shared/events/user-access-changed.event';
import {
  ApprovalAudienceService,
  AudienceItem,
  AudiencePeople,
  AudienceSubject,
  decidersOf,
  viewersOf,
} from './approval-audience.service';

/**
 * 4.0 routing (docs/4.0/SPEC.md 1.3): two organisations. Org A has d1 (managers mgr1
 * and mgr2), d2 (nobody manages it) and the Admin adminA; org B has adminB and mgrB.
 * The Super Admin sa1 and the Super Manager sm1 belong to no organisation.
 */
const staff = (over: Partial<AudienceSubject> = {}): AudienceSubject => ({
  id: 'u1',
  role: 'USER',
  companyId: 'org-a',
  departmentId: 'd1',
  orgLive: true,
  ...over,
});
const people = (over: Partial<AudiencePeople> = {}): AudiencePeople => ({
  departmentManagerIds: ['mgr1', 'mgr2'],
  adminIds: ['adminA'],
  superManagerIds: ['sm1'],
  superAdminIds: ['sa1'],
  ...over,
});
const item = (over: Partial<AudienceItem> = {}): AudienceItem => ({
  userId: 'u1',
  approverRole: 'MANAGER',
  status: 'PENDING',
  ...over,
});

describe('decidersOf (3.6 on 4.0 routing)', () => {
  it("Staff on the Manager route wait on their department's managers", () => {
    expect(decidersOf(item(), staff(), people())).toEqual(['mgr1', 'mgr2']);
  });

  it('a department nobody manages falls to the organisation admins, never further', () => {
    expect(
      decidersOf(item(), staff({ departmentId: 'd2' }), people({ departmentManagerIds: [] })),
    ).toEqual(['adminA']);
    expect(decidersOf(item(), staff({ departmentId: null }), people())).toEqual(['adminA']);
  });

  it("a Manager's own item waits on the admins, not on department managers", () => {
    const mgr = staff({ id: 'mgrX', role: 'MANAGER' });
    expect(decidersOf(item({ userId: 'mgrX' }), mgr, people())).toEqual(['adminA']);
    expect(decidersOf(item({ userId: 'mgrX', approverRole: 'ADMIN' }), mgr, people())).toEqual([
      'adminA',
    ]);
  });

  it('an organisation with no admin left falls to the Super Admins', () => {
    expect(decidersOf(item({ approverRole: 'ADMIN' }), staff(), people({ adminIds: [] }))).toEqual([
      'sa1',
    ]);
  });

  it("the Super Manager's and Super Admins' routes are theirs", () => {
    expect(decidersOf(item({ approverRole: 'SUPER_MANAGER' }), staff(), people())).toEqual(['sm1']);
    expect(
      decidersOf(item({ approverRole: 'SUPER_MANAGER' }), staff(), people({ superManagerIds: [] })),
    ).toEqual(['adminA']);
    const admin = staff({ id: 'adminA', role: 'ADMIN', departmentId: null });
    expect(
      decidersOf(item({ userId: 'adminA', approverRole: 'SUPER_ADMIN' }), admin, people()),
    ).toEqual(['sa1']);
  });

  it('an item past due also waits on the admins (their queue holds every escalated item)', () => {
    expect(decidersOf(item({ escalated: true }), staff(), people())).toEqual([
      'mgr1',
      'mgr2',
      'adminA',
    ]);
  });

  it('never the person themselves', () => {
    const admin = staff({ id: 'adminA', role: 'ADMIN', departmentId: null });
    expect(decidersOf(item({ userId: 'adminA', approverRole: 'ADMIN' }), admin, people())).toEqual([
      'sa1',
    ]);
  });

  it('nobody for an item approved at once, or in an organisation that was deleted', () => {
    expect(decidersOf(item({ approverRole: null, status: 'APPROVED' }), staff(), people())).toEqual(
      [],
    );
    expect(decidersOf(item(), staff({ orgLive: false }), people())).toEqual([]);
  });
});

describe('viewersOf (3.6 on 4.0 routing)', () => {
  it("Staff's items: the person, their department's managers, the admins and the platform roles", () => {
    expect(viewersOf(staff(), ['mgr1', 'mgr2'], people())).toEqual([
      'u1',
      'mgr1',
      'mgr2',
      'adminA',
      'sa1',
      'sm1',
    ]);
  });

  it("a Manager's items are not shown to department managers", () => {
    const mgr = staff({ id: 'mgrX', role: 'MANAGER' });
    expect(viewersOf(mgr, ['adminA'], people({ departmentManagerIds: [] }))).toEqual([
      'mgrX',
      'adminA',
      'sa1',
      'sm1',
    ]);
  });

  it("a Super Admin's own items only to the Super Admins", () => {
    const sa = staff({ id: 'sa2', role: 'SUPER_ADMIN', companyId: null, departmentId: null });
    expect(viewersOf(sa, ['sa1'], people())).toEqual(['sa2', 'sa1']);
  });

  it('an organisation that was deleted leaves only the person', () => {
    expect(viewersOf(staff({ orgLive: false }), [], people())).toEqual(['u1']);
  });
});

/** A small in-memory world behind the Prisma calls the service makes. */
interface Person {
  id: string;
  role: string;
  companyId: string | null;
  departmentId: string | null;
  status?: string;
  deletedAt?: Date | null;
  managed?: string[];
  companyDeleted?: boolean;
}

const WORLD: Person[] = [
  { id: 'u1', role: 'USER', companyId: 'org-a', departmentId: 'd1' },
  { id: 'u2', role: 'USER', companyId: 'org-a', departmentId: 'd2' },
  { id: 'u3', role: 'USER', companyId: 'org-a', departmentId: 'd1' },
  { id: 'mgr1', role: 'MANAGER', companyId: 'org-a', departmentId: 'd1', managed: ['d1'] },
  { id: 'mgr2', role: 'MANAGER', companyId: 'org-a', departmentId: 'd1', managed: ['d1'] },
  {
    id: 'mgrBlocked',
    role: 'MANAGER',
    companyId: 'org-a',
    departmentId: 'd2',
    managed: ['d2'],
    status: 'DISABLED',
  },
  // A manager of another organisation, wrongly linked to org A's d1: never reached.
  { id: 'mgrB', role: 'MANAGER', companyId: 'org-b', departmentId: 'd3', managed: ['d1', 'd3'] },
  { id: 'adminA', role: 'ADMIN', companyId: 'org-a', departmentId: null },
  { id: 'adminB', role: 'ADMIN', companyId: 'org-b', departmentId: null },
  { id: 'sa1', role: 'SUPER_ADMIN', companyId: null, departmentId: null },
  { id: 'sm1', role: 'SUPER_MANAGER', companyId: null, departmentId: null },
  { id: 'gone', role: 'USER', companyId: 'org-x', departmentId: null, companyDeleted: true },
];
const DEPT_ORG: Record<string, string> = { d1: 'org-a', d2: 'org-a', d3: 'org-b' };

const active = (p: Person) => (p.status ?? 'ACTIVE') === 'ACTIVE' && !p.deletedAt;

type Where = Record<string, any>;

function world(rows: Record<string, unknown> = {}, people: Person[] = WORLD) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const finder = (name: string) => ({
    findUnique: jest.fn().mockResolvedValue(rows[name] ?? null),
    findMany: jest.fn().mockResolvedValue((rows[`${name}s`] as unknown[]) ?? []),
  });
  const prisma = {
    breakRecord: finder('break'),
    meetingRecord: finder('meeting'),
    awayEvent: finder('away'),
    leaveRequest: finder('leave'),
    wfhRequest: finder('wfh'),
    compOffCredit: finder('compoff'),
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = byId.get(where.id);
        if (!p) return null;
        return {
          id: p.id,
          companyId: p.companyId,
          departmentId: p.departmentId,
          status: p.status ?? 'ACTIVE',
          deletedAt: p.deletedAt ?? null,
          role: { name: p.role },
          company: p.companyId ? { deletedAt: p.companyDeleted ? new Date() : null } : null,
          managedDepartments: (p.managed ?? []).map((departmentId) => ({ departmentId })),
        };
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        people
          .filter((p) => {
            if (where.deletedAt === null && p.deletedAt) return false;
            if (where.status === 'ACTIVE' && !active(p)) return false;
            if ('companyId' in where && p.companyId !== where.companyId) return false;
            if ('departmentId' in where && p.departmentId !== where.departmentId) return false;
            const role = where.role?.name;
            if (typeof role === 'string' && p.role !== role) return false;
            if (role?.in && !role.in.includes(p.role)) return false;
            return true;
          })
          .map((p) => ({ id: p.id, role: { name: p.role } })),
      ),
    },
    managerDepartment: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        people
          .filter((m) => (m.managed ?? []).includes(where.departmentId))
          .filter(
            (m) =>
              DEPT_ORG[where.departmentId] === where.department.companyId &&
              m.companyId === where.manager.companyId &&
              active(m) &&
              m.role === where.manager.role.name,
          )
          .map((m) => ({ managerId: m.id })),
      ),
    },
  };
  return { svc: new ApprovalAudienceService(prisma as never), prisma };
}

describe('ApprovalAudienceService.of (3.6 on 4.0)', () => {
  it("reads a break of Staff: the department's managers decide it, never another organisation's", async () => {
    const { svc, prisma } = world({
      break: {
        userId: 'u1',
        approverRole: 'MANAGER',
        approvalStatus: 'PENDING',
        escalatedAt: null,
      },
    });
    await expect(svc.of('BREAK', 'b1')).resolves.toEqual({
      status: 'PENDING',
      deciders: ['mgr1', 'mgr2'],
      viewers: ['u1', 'mgr1', 'mgr2', 'adminA', 'sa1', 'sm1'],
    });
    // The department and its managers are both held to the person's organisation.
    expect(prisma.managerDepartment.findMany.mock.calls[0][0].where).toEqual({
      departmentId: 'd1',
      department: { deletedAt: null, companyId: 'org-a' },
      manager: {
        companyId: 'org-a',
        deletedAt: null,
        status: 'ACTIVE',
        role: { name: 'MANAGER' },
      },
    });
    // Admins of the person's organisation only.
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: 'org-a',
      role: { name: 'ADMIN' },
    });
  });

  it('a department whose only manager is blocked waits on the admins', async () => {
    const { svc } = world({
      leave: { userId: 'u2', approverRole: 'MANAGER', status: 'PENDING' },
    });
    await expect(svc.of('LEAVE', 'l1')).resolves.toEqual({
      status: 'PENDING',
      deciders: ['adminA'],
      viewers: ['u2', 'adminA', 'sa1', 'sm1'],
    });
  });

  it('4.0: reads away time by its status, and its escalation', async () => {
    const { svc } = world({
      away: { userId: 'u1', approverRole: 'MANAGER', status: 'PENDING', escalatedAt: new Date() },
    });
    await expect(svc.of('AWAY', 'a1')).resolves.toMatchObject({
      status: 'PENDING',
      deciders: ['mgr1', 'mgr2', 'adminA'],
    });
  });

  it('4.0: unexplained away time is not an approval: nothing to refresh', async () => {
    const { svc } = world({
      away: { userId: 'u1', approverRole: null, status: 'UNEXPLAINED', escalatedAt: null },
    });
    await expect(svc.of('AWAY', 'a1')).resolves.toBeNull();
  });

  it.each([
    ['LEAVE', 'leave'],
    ['WFH', 'wfh'],
    ['COMPOFF', 'compoff'],
  ] as const)('reads %s by its status, on the route it was given', async (what, name) => {
    const { svc } = world({
      [name]: { userId: 'u1', approverRole: 'SUPER_MANAGER', status: 'PENDING' },
    });
    await expect(svc.of(what, 'x')).resolves.toMatchObject({
      status: 'PENDING',
      deciders: ['sm1'],
    });
  });

  it("a Manager's meeting goes to the admins, and department managers do not see it", async () => {
    const { svc } = world({
      meeting: {
        userId: 'mgr1',
        approverRole: 'ADMIN',
        approvalStatus: 'APPROVED',
        escalatedAt: null,
        mode: 'PAST',
        endedAt: new Date(),
        durationSec: 1800,
      },
    });
    await expect(svc.of('MEETING', 'm1')).resolves.toEqual({
      status: 'APPROVED',
      deciders: ['adminA'],
      viewers: ['mgr1', 'adminA', 'sa1', 'sm1'],
    });
  });

  it('a live meeting discarded on ending is told to whoever saw it run', async () => {
    const { svc } = world({
      meeting: {
        userId: 'u1',
        approverRole: null,
        approvalStatus: 'NOT_REQUIRED',
        escalatedAt: null,
        mode: 'LIVE',
        endedAt: new Date(),
        durationSec: 20,
      },
    });
    await expect(svc.of('MEETING', 'x')).resolves.toEqual({
      status: 'NOT_REQUIRED',
      deciders: [],
      viewers: ['u1', 'adminA', 'mgr1', 'mgr2', 'sa1', 'sm1'],
    });
  });

  it('a status meeting, running or ended, needs no approval and stays silent', async () => {
    const row = {
      userId: 'u1',
      approverRole: null,
      approvalStatus: 'NOT_REQUIRED',
      escalatedAt: null,
      mode: 'LIVE',
    };
    for (const patch of [
      { endedAt: null, durationSec: null },
      { endedAt: new Date(), durationSec: 600 },
    ]) {
      const { svc } = world({ meeting: { ...row, ...patch } });
      await expect(svc.of('MEETING', 'x')).resolves.toBeNull();
    }
  });

  it('an organisation that was deleted: only the person hears of it', async () => {
    const { svc } = world({
      leave: { userId: 'gone', approverRole: 'ADMIN', status: 'PENDING' },
    });
    await expect(svc.of('LEAVE', 'l1')).resolves.toEqual({
      status: 'PENDING',
      deciders: [],
      viewers: ['gone'],
    });
  });

  it('is null for an item that is gone, or a person who is', async () => {
    await expect(world({}).svc.of('LEAVE', 'missing')).resolves.toBeNull();
    const { svc } = world({ wfh: { userId: 'nobody', approverRole: 'ADMIN', status: 'PENDING' } });
    await expect(svc.of('WFH', 'w1')).resolves.toBeNull();
  });

  it('asks only for the active Super Admins and Super Managers', async () => {
    const { svc, prisma } = world({
      leave: { userId: 'u1', approverRole: 'MANAGER', status: 'PENDING' },
    });
    await svc.of('LEAVE', 'x');
    const platform = prisma.user.findMany.mock.calls
      .map((c) => c[0].where)
      .find((w: Where) => w.role?.name?.in);
    expect(platform).toEqual({
      deletedAt: null,
      status: 'ACTIVE',
      role: { name: { in: ['SUPER_ADMIN', 'SUPER_MANAGER'] } },
    });
  });
});

describe('ApprovalAudienceService.movedBy (3.6 on 4.0)', () => {
  const change = (userId: string, changes: UserAccessChange[], former?: FormerPlacement) =>
    new UserAccessChangedEvent(userId, changes, new Date(), true, former);
  const ids = (rows: { id: string }[]) => rows;

  it("Staff moved to another department: their own items are new to the new department's deciders, and the old managers are told", async () => {
    const moved = WORLD.map((p) => (p.id === 'u1' ? { ...p, departmentId: 'd2' } : p));
    const { svc, prisma } = world(
      {
        breaks: [{ id: 'b1', approverRole: 'MANAGER' }],
        meetings: [
          { id: 'm1', approverRole: 'MANAGER', endedAt: new Date() },
          { id: 'm2', approverRole: 'MANAGER', endedAt: null },
        ],
        aways: ids([{ id: 'a1' }]),
        leaves: ids([{ id: 'l1' }]),
        wfhs: ids([{ id: 'w1' }]),
        compoffs: ids([{ id: 'c1' }]),
      },
      moved,
    );
    const out = await svc.movedBy(
      change('u1', ['ROLE'], { role: 'USER', departmentId: 'd1', managedDepartmentIds: [] }),
    );
    const told = ['mgr1', 'mgr2'];
    expect(out).toEqual([
      { what: 'BREAK', id: 'b1', action: 'CREATED', formerApprovers: told },
      { what: 'MEETING', id: 'm1', action: 'CREATED', formerApprovers: told },
      // Still running: it cannot be decided yet, so nobody is pushed.
      { what: 'MEETING', id: 'm2', action: 'UPDATED', formerApprovers: told },
      { what: 'AWAY', id: 'a1', action: 'CREATED', formerApprovers: told },
      { what: 'LEAVE', id: 'l1', action: 'CREATED', formerApprovers: told },
      { what: 'WFH', id: 'w1', action: 'CREATED', formerApprovers: told },
      { what: 'COMPOFF', id: 'c1', action: 'CREATED', formerApprovers: told },
    ]);
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where).toEqual({
      userId: 'u1',
      status: 'PENDING',
    });
  });

  it('Staff made a Manager: breaks and meetings the re-route rewrites are only told to the old managers', async () => {
    const promoted = WORLD.map((p) => (p.id === 'u1' ? { ...p, role: 'MANAGER' } : p));
    const { svc } = world(
      {
        breaks: [{ id: 'b1', approverRole: 'MANAGER' }],
        meetings: [{ id: 'm1', approverRole: 'MANAGER', endedAt: new Date() }],
      },
      promoted,
    );
    const out = await svc.movedBy(
      change('u1', ['ROLE'], { role: 'USER', departmentId: 'd1', managedDepartmentIds: [] }),
    );
    expect(out.filter((c) => c.what === 'BREAK' || c.what === 'MEETING')).toEqual([
      { what: 'BREAK', id: 'b1', action: 'UPDATED', formerApprovers: ['mgr1', 'mgr2'] },
      { what: 'MEETING', id: 'm1', action: 'UPDATED', formerApprovers: ['mgr1', 'mgr2'] },
    ]);
  });

  it('a Manager leaving a department others still manage: UPDATED, and they are told by name', async () => {
    const left = WORLD.map((p) => (p.id === 'mgr1' ? { ...p, managed: [] } : p));
    const { svc, prisma } = world({ leaves: [{ id: 'l1' }], aways: [{ id: 'a1' }] }, left);
    const out = await svc.movedBy(
      change('mgr1', ['ROLE'], {
        role: 'MANAGER',
        departmentId: 'd1',
        managedDepartmentIds: ['d1'],
      }),
    );
    expect(out).toEqual([
      { what: 'AWAY', id: 'a1', action: 'UPDATED', formerApprovers: ['mgr1'] },
      { what: 'LEAVE', id: 'l1', action: 'UPDATED', formerApprovers: ['mgr1'] },
    ]);
    // The department's Staff of the same organisation, on the Manager route.
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      departmentId: 'd1',
      companyId: 'org-a',
      deletedAt: null,
      role: { name: 'USER' },
    });
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where).toEqual({
      userId: { in: ['u1', 'u3'] },
      approverRole: 'MANAGER',
      status: 'PENDING',
    });
  });

  it('a Manager given a department nobody managed: its waiting items are new to them', async () => {
    const given = WORLD.map((p) => (p.id === 'mgr1' ? { ...p, managed: ['d1', 'd2'] } : p));
    const { svc } = world({ wfhs: [{ id: 'w2' }] }, given);
    const out = await svc.movedBy(
      change('mgr1', ['ROLE'], {
        role: 'MANAGER',
        departmentId: 'd1',
        managedDepartmentIds: ['d1'],
      }),
    );
    expect(out).toEqual([{ what: 'WFH', id: 'w2', action: 'CREATED', formerApprovers: [] }]);
  });

  it.each([['STATUS'], ['DELETED']] as const)(
    "a department's only manager %s: what waited on them goes to the admins, and they are told",
    async (kind) => {
      const alone = WORLD.map((p) =>
        p.id === 'mgr2'
          ? { ...p, managed: [] }
          : p.id === 'mgr1'
            ? { ...p, status: 'DISABLED' }
            : p,
      );
      const { svc } = world({ compoffs: [{ id: 'c1' }] }, alone);
      await expect(svc.movedBy(change('mgr1', [kind]))).resolves.toEqual([
        { what: 'COMPOFF', id: 'c1', action: 'CREATED', formerApprovers: ['mgr1'] },
      ]);
    },
  );

  it('a manager back from a block takes up their departments again', async () => {
    const back = WORLD.map((p) => (p.id === 'mgrBlocked' ? { ...p, status: 'ACTIVE' } : p));
    const { svc } = world({ leaves: [{ id: 'l2' }] }, back);
    await expect(svc.movedBy(change('mgrBlocked', ['STATUS']))).resolves.toEqual([
      { what: 'LEAVE', id: 'l2', action: 'CREATED', formerApprovers: [] },
    ]);
  });

  it.each([['PASSWORD'], ['SIGN_OUT']] as const)('%s moves nothing', async (kind) => {
    const { svc, prisma } = world({ leaves: [{ id: 'l1' }] });
    await expect(svc.movedBy(change('u1', [kind]))).resolves.toEqual([]);
    expect(prisma.leaveRequest.findMany).not.toHaveBeenCalled();
  });

  it('grants alone (a role event with no placement) move nothing', async () => {
    const { svc, prisma } = world({ leaves: [{ id: 'l1' }] });
    await expect(svc.movedBy(change('mgr1', ['ROLE']))).resolves.toEqual([]);
    expect(prisma.leaveRequest.findMany).not.toHaveBeenCalled();
  });

  it('someone outside any organisation moves nothing', async () => {
    const { svc } = world({ leaves: [{ id: 'l1' }] });
    await expect(
      svc.movedBy(
        change('sm1', ['ROLE'], { role: 'USER', departmentId: null, managedDepartmentIds: [] }),
      ),
    ).resolves.toEqual([]);
  });
});
