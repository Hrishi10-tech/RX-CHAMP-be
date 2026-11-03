import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { OrgsInViewService } from '@shared/tenancy';
import { CombinedReportsService } from './combined-reports.service';

/** 3.3 combined reports: built per organisation (its own settings), concatenated. */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const P_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-03T06:00:00Z');

const SM = {
  id: 'sm',
  email: 'sm@x.test',
  role: Role.SUPER_MANAGER,
  permissions: [],
  department: null,
  companyId: null,
  status: 'ACTIVE',
  orgId: null,
} as AuthenticatedUser;

function person(id: string) {
  return {
    id,
    name: id,
    email: '',
    role: 'USER',
    department: null,
    designation: null,
    managerId: null,
    managerName: null,
  };
}

describe('CombinedReportsService', () => {
  const orgs = [
    { id: ORG_A, name: 'Acme' },
    { id: ORG_B, name: 'Beta' },
  ];
  const prisma = {
    company: {
      findMany: jest.fn(async () => orgs),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null,
      ),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: P_A, companyId: ORG_A },
        { id: P_B, companyId: ORG_B },
      ]),
    },
  };
  const reports = {
    people: jest.fn(async (me: AuthenticatedUser) => ({
      items: [person(me.orgId === ORG_A ? P_A : P_B)],
    })),
    teamDay: jest.fn(async (me: AuthenticatedUser, date: string, ids?: string[]) => ({
      date: '2026-11-03',
      rows: (ids ?? [me.orgId === ORG_A ? P_A : P_B]).map((id) => ({
        person: person(id),
        summary: {},
      })),
    })),
    assertMonthInRange: jest.fn(async () => undefined),
    teamMonthWithPersons: jest.fn(),
  };
  const svc = new CombinedReportsService(reports as never, new OrgsInViewService(prisma as never));

  beforeEach(() => jest.clearAllMocks());

  it('people: every organisation, each person tagged with it', async () => {
    const out = await svc.people(SM, NOW);
    expect(out.items.map((p) => [p.id, p.companyName])).toEqual([
      [P_A, 'Acme'],
      [P_B, 'Beta'],
    ]);
  });

  it('team day with userIds: each organisation gets only its own people; an unknown id is 404', async () => {
    const out = await svc.teamDay(SM, { userIds: [P_B] }, NOW);
    expect(reports.teamDay).toHaveBeenCalledTimes(1);
    expect((reports.teamDay.mock.calls[0][0] as AuthenticatedUser).orgId).toBe(ORG_B);
    expect(out.rows.map((r) => (r.person as { companyName?: string }).companyName)).toEqual([
      'Beta',
    ]);
    await expect(
      svc.teamDay(SM, { userIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] }, NOW),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a department filter on All organisations needs one organisation', async () => {
    await expect(svc.teamDay(SM, { departmentId: 'd1' }, NOW)).rejects.toMatchObject({
      code: 'ORG_REQUIRED',
    });
  });
});
