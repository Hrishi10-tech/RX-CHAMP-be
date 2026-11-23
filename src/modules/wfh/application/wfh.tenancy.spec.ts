import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { LeavePeopleService } from '@modules/leave/application/leave-people.service';
import { WfhRequestRecord, WfhScheduleRecord } from '../domain/wfh';
import { WfhPolicyService, wfhPolicyKey } from './wfh-policy.service';
import { WfhRequestsService } from './wfh-requests.service';
import { WfhSchedulesService } from './wfh-schedules.service';

/**
 * Work from home (3.5) on 4.0's tenancy: each organisation has its own policy;
 * schedules are set by whoever sees the person among department managers, the
 * organisation admin and above; requests are decided on the leave routes (the
 * department's managers, else the organisation admin), never across organisations.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-23T06:00:00Z');

const person = (id: string, role: string, companyId = ORG, departmentId: string | null = 'd1') => ({
  id,
  firstName: id,
  lastName: '',
  email: `${id}@rx.test`,
  role,
  department: departmentId ? `Dept ${departmentId}` : null,
  designation: null,
  companyId,
  departmentId,
  managerId: null,
  active: true,
  attendanceSource: 'AGENT' as const,
  biometricCode: null,
  attendanceSourceFrom: null,
});
const PEOPLE = [
  person('staff', 'USER'),
  person('other', 'USER', ORG, 'd2'),
  person('mgr', 'MANAGER', ORG, null),
  person('admin', 'ADMIN', ORG, null),
  person('far', 'USER', OTHER, 'dx'),
];

const actor = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}) =>
  ({
    id,
    role,
    companyId: role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER ? null : ORG,
    orgId: ORG,
    departmentId: null,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    ...over,
  }) as unknown as AuthenticatedUser;

function people(): LeavePeopleService {
  const reader = {
    findAnyByIds: jest.fn(async (ids: string[]) => PEOPLE.filter((p) => ids.includes(p.id))),
    findMany: jest.fn(
      async (q: { companyId?: string; departmentIds?: string[]; roles?: string[] }) =>
        PEOPLE.filter(
          (p) =>
            (!q.companyId || p.companyId === q.companyId) &&
            (!q.departmentIds || (p.departmentId && q.departmentIds.includes(p.departmentId))) &&
            (!q.roles || q.roles.includes(p.role)),
        ),
    ),
    listDepartmentManagerIds: jest.fn(async (d: string) => (d === 'd1' ? ['mgr'] : [])),
    listOrgAdminIds: jest.fn(async (c: string) => (c === ORG ? ['admin'] : [])),
    listSuperAdminIds: jest.fn(async () => ['sa']),
  };
  const repo = { activeRoleIds: jest.fn(async () => []) };
  const calendar = {
    forOrg: jest.fn(async () => ({ weekPattern: [1, 2, 3, 4, 5], overrides: new Map() })),
  };
  return new LeavePeopleService(reader as never, repo as never, {} as never, calendar as never);
}

const events = () => ({ publish: jest.fn(async () => undefined) });

describe('WfhPolicyService per organisation (4.0)', () => {
  function store(initial: Record<string, unknown> = {}) {
    const rows = new Map(Object.entries(initial));
    return {
      rows,
      read: jest.fn(async (k: string) => rows.get(k) ?? null),
      write: jest.fn(async (k: string, v: unknown) => void rows.set(k, v)),
    };
  }

  it("reads the platform's policy until the organisation saves its own", async () => {
    const s = store({ wfh: { noticeDays: 3 } });
    const svc = new WfhPolicyService(s as never);
    expect((await svc.get(ORG)).noticeDays).toBe(3);
    await svc.update(ORG, { noticeDays: 5 }, { mayRoute: true, updatedById: 'admin' });
    expect(s.rows.get(wfhPolicyKey(ORG))).toMatchObject({ noticeDays: 5 });
    expect(s.rows.get('wfh')).toEqual({ noticeDays: 3 });
    expect((await svc.get(ORG)).noticeDays).toBe(5);
    // Another organisation is untouched.
    expect((await svc.get(OTHER)).noticeDays).toBe(3);
  });

  it("each person's policy comes from their organisation", async () => {
    const s = store({ [wfhPolicyKey(ORG)]: { maxDaysPerMonth: 4 } });
    const policyOf = await new WfhPolicyService(s as never).forPeople([
      { companyId: ORG },
      { companyId: OTHER },
    ]);
    expect(policyOf({ companyId: ORG }).maxDaysPerMonth).toBe(4);
    expect(policyOf({ companyId: OTHER }).maxDaysPerMonth).toBeNull();
  });
});

describe('WfhSchedulesService: who sets a schedule (4.0)', () => {
  const schedule = (userId: string): WfhScheduleRecord => ({
    id: `s-${userId}`,
    userId,
    weekdays: [5],
    weeks: [],
    kind: 'FULL_DAY',
    part: null,
    fromDate: '2026-12-01',
    toDate: null,
    skipDates: [],
    note: '',
    createdById: 'admin',
    updatedById: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  function setup() {
    const repo = {
      findSchedule: jest.fn(async (id: string) => schedule(id.slice(2))),
      deleteSchedule: jest.fn(async () => true),
      updateSchedule: jest.fn(),
    };
    return { svc: new WfhSchedulesService(repo as never, events() as never, people()), repo };
  }

  it("a Manager ends schedules of their departments' Staff, nobody else's", async () => {
    const { svc, repo } = setup();
    const me = actor('mgr', Role.MANAGER);
    await expect(svc.end(me, 's-staff', NOW)).resolves.toEqual({ ended: true, removed: true });
    await expect(svc.end(me, 's-other', NOW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.end(me, 's-far', NOW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.end(me, 's-mgr', NOW)).rejects.toMatchObject({ status: 403 });
    expect(repo.deleteSchedule).toHaveBeenCalledTimes(1);
  });

  it("the organisation admin sets anyone's in the organisation, never another organisation's", async () => {
    const { svc } = setup();
    const me = actor('admin', Role.ADMIN);
    await expect(svc.end(me, 's-staff', NOW)).resolves.toMatchObject({ ended: true });
    await expect(svc.end(me, 's-mgr', NOW)).resolves.toMatchObject({ ended: true });
    await expect(svc.end(me, 's-far', NOW)).rejects.toMatchObject({ status: 404 });
  });

  it('Staff cannot set schedules', async () => {
    const { svc } = setup();
    await expect(svc.end(actor('other', Role.USER), 's-staff', NOW)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('says on each schedule whether the caller may change it', async () => {
    const { svc } = setup();
    const views = await svc.views(
      actor('mgr', Role.MANAGER),
      [schedule('staff'), schedule('other')],
      NOW,
    );
    expect(views.map((v) => v.can.edit)).toEqual([true, false]);
  });
});

describe('WfhRequestsService: who decides (4.0)', () => {
  const request = (userId: string, approverRole: WfhRequestRecord['approverRole']) =>
    ({
      id: `r-${userId}`,
      userId,
      kind: 'FULL_DAY',
      part: null,
      startDate: '2026-12-01',
      endDate: '2026-12-01',
      units: 4,
      reason: 'Plumber',
      status: 'PENDING',
      approverRole,
      approverId: null,
      decidedById: null,
      decidedAt: null,
      decisionNote: null,
      cancelledAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      days: [{ id: 'd', requestId: `r-${userId}`, userId, date: '2026-12-01', mask: 15, units: 4 }],
    }) as unknown as WfhRequestRecord;

  function setup(rows: WfhRequestRecord[]) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tx = {
      findRequest: jest.fn(async (id: string) => byId.get(id) ?? null),
      assertMonthOpen: jest.fn(async () => undefined),
      updateRequest: jest.fn(async (id: string, patch: Partial<WfhRequestRecord>) => ({
        ...byId.get(id)!,
        ...patch,
      })),
    };
    const repo = {
      findRequest: tx.findRequest,
      inUserLock: jest.fn(async (_u: string, fn: (t: typeof tx) => unknown) => fn(tx)),
      listRequests: jest.fn(async () => rows),
      lockedMonths: jest.fn(async () => new Set<string>()),
    };
    const p = people();
    jest.spyOn(p, 'shiftTimes').mockResolvedValue(new Map());
    const svc = new WfhRequestsService(
      repo as never,
      events() as never,
      {} as never,
      p,
      {} as never,
      {} as never,
    );
    return { svc, tx };
  }

  it("a department's Manager rejects their Staff's request; another department's cannot see it", async () => {
    const { svc, tx } = setup([request('staff', 'MANAGER'), request('other', 'MANAGER')]);
    const me = actor('mgr', Role.MANAGER);
    await expect(svc.decide(me, 'r-staff', false, 'Not this week', NOW)).resolves.toMatchObject({
      status: 'REJECTED',
    });
    expect(tx.assertMonthOpen).toHaveBeenCalledWith('2026-12-01', 'staff');
    await expect(svc.decide(me, 'r-other', false, 'Not now', NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('nobody decides across organisations; the organisation admin decides in theirs', async () => {
    const { svc } = setup([request('far', 'MANAGER'), request('mgr', 'ADMIN')]);
    await expect(
      svc.decide(actor('admin', Role.ADMIN), 'r-far', false, 'Not now', NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.decide(actor('admin', Role.ADMIN), 'r-mgr', false, 'Not now', NOW),
    ).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('"Needs you": the Manager for their department, the admin for a department without one', async () => {
    const rows = [request('staff', 'MANAGER'), request('other', 'MANAGER')];
    const mgr = await setup(rows).svc.list(actor('mgr', Role.MANAGER), { needsMe: true }, NOW);
    expect(mgr.items.map((v) => v.id)).toEqual(['r-staff']);
    const admin = await setup(rows).svc.list(actor('admin', Role.ADMIN), { needsMe: true }, NOW);
    expect(admin.items.map((v) => v.id)).toEqual(['r-other']);
  });
});
