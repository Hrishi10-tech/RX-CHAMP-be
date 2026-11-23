import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { LeavePeopleService } from '@modules/leave/application/leave-people.service';
import { CompOffCreditRecord } from '@modules/leave/domain/comp-off';
import { CompOffService } from './compoff.service';

/**
 * Comp off (3.5) on 4.0's tenancy: claims route like leave (the department's
 * managers, else the organisation admin), nobody decides or credits across
 * organisations or departments, the rules are the person's organisation's leave
 * policy, and a day off set on the organisation calendar is a holiday.
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

const actor = (id: string, role: Role) =>
  ({
    id,
    role,
    companyId: ORG,
    orgId: ORG,
    departmentId: null,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
  }) as unknown as AuthenticatedUser;

function people(calendar: unknown = {}) {
  const reader = {
    findAnyByIds: jest.fn(async (ids: string[]) => PEOPLE.filter((p) => ids.includes(p.id))),
    listDepartmentManagerIds: jest.fn(async (d: string) => (d === 'd1' ? ['mgr'] : [])),
    listOrgAdminIds: jest.fn(async () => ['admin']),
    listSuperAdminIds: jest.fn(async () => []),
  };
  const shifts = {
    context: jest.fn(async () => ({})),
    resolveWith: jest.fn(() => ({ shift: null })),
  };
  return new LeavePeopleService(
    reader as never,
    { activeRoleIds: jest.fn(async () => []) } as never,
    shifts as never,
    calendar as never,
  );
}

const claim = (userId: string): CompOffCreditRecord =>
  ({
    id: `c-${userId}`,
    userId,
    workedDate: '2026-11-22',
    dayKind: 'WEEKLY_OFF',
    dayLabel: 'Sunday',
    workedSec: 30_000,
    askedUnits: 4,
    units: 0,
    reason: 'Release night',
    source: 'CLAIM',
    status: 'PENDING',
    approverRole: 'MANAGER',
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    expiresOn: null,
    expiryNoticeAt: null,
    createdById: userId,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as CompOffCreditRecord;

function setup() {
  const rows = new Map(['staff', 'other', 'far'].map((u) => [`c-${u}`, claim(u)]));
  const tx = {
    findCredit: jest.fn(async (id: string) => rows.get(id) ?? null),
    updateCredit: jest.fn(async (id: string, patch: Partial<CompOffCreditRecord>) => ({
      ...rows.get(id)!,
      ...patch,
    })),
  };
  const repo = {
    findCredit: tx.findCredit,
    inUserLock: jest.fn(async (_u: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    creditsOf: jest.fn(async () => []),
    compOffUsesOf: jest.fn(async () => new Map()),
  };
  const policies = { get: jest.fn(async () => ({ compOffEnabled: true })) };
  const p = people();
  const svc = new CompOffService(
    repo as never,
    { publish: jest.fn(async () => undefined) } as never,
    p,
    policies as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, policies };
}

describe('CompOffService on 4.0 tenancy', () => {
  it("a department's Manager rejects their Staff's claim, under that organisation's policy", async () => {
    const { svc, policies } = setup();
    await expect(
      svc.decide(actor('mgr', Role.MANAGER), 'c-staff', false, { note: 'Not agreed' }, NOW),
    ).resolves.toMatchObject({ status: 'REJECTED' });
    expect(policies.get).toHaveBeenCalledWith(ORG, NOW);
  });

  it("another department's or organisation's claim does not exist for the caller (404)", async () => {
    const { svc } = setup();
    await expect(
      svc.decide(actor('mgr', Role.MANAGER), 'c-other', false, { note: 'Not agreed' }, NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.decide(actor('admin', Role.ADMIN), 'c-far', false, { note: 'Not agreed' }, NOW),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('credits by hand only for people the caller sees; never by Staff', async () => {
    const { svc } = setup();
    const dto = { date: '2026-11-22', days: 1, reason: 'Release night support' };
    await expect(
      svc.grant(actor('mgr', Role.MANAGER), { ...dto, userId: 'other' }, NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.grant(actor('staff', Role.USER), { ...dto, userId: 'other' }, NOW),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('a day off set on the organisation calendar is a holiday (comp off)', () => {
  it('names the holiday; a weekly day off is no holiday', async () => {
    const calendar = {
      forOrg: jest.fn(async () => ({
        weekPattern: [1, 2, 3, 4, 5],
        overrides: new Map([
          ['2026-11-23', { isWorking: false, label: 'Founders day', departmentIds: [] }],
          ['2026-11-24', { isWorking: false, label: null, departmentIds: [] }],
        ]),
      })),
    };
    const days = await people(calendar).dayInfos(PEOPLE[0] as never, [
      '2026-11-22',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ]);
    expect(days.map((d) => [d.workday, d.holiday])).toEqual([
      [false, null],
      [false, 'Founders day'],
      [false, 'Holiday'],
      [true, null],
    ]);
  });
});
