import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { actingIn, allOrgsInView, sumTotals, withOrg } from './combined';
import { OrgsInViewService } from './orgs-in-view.service';
import { canSeePerson } from './scope';

/** 3.3 combined views ("All organisations") on top of the 4.0 scope rules. */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function actor(role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const platform = role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER;
  return {
    id: `${role.toLowerCase()}-me`,
    email: 'x@x.test',
    role,
    permissions: [],
    department: null,
    companyId: platform ? null : ORG_A,
    status: 'ACTIVE',
    orgId: platform ? null : ORG_A,
    ...over,
  } as AuthenticatedUser;
}

describe('allOrgsInView / actingIn', () => {
  it('only the Super Manager and Super Admin with no organisation picked', () => {
    expect(allOrgsInView(actor(Role.SUPER_MANAGER))).toBe(true);
    expect(allOrgsInView(actor(Role.SUPER_ADMIN))).toBe(true);
    expect(allOrgsInView(actor(Role.SUPER_MANAGER, { orgId: ORG_A }))).toBe(false);
    expect(allOrgsInView(actor(Role.SUPER_ADMIN, { orgHeaderInvalid: true }))).toBe(false);
    for (const role of [Role.ADMIN, Role.MANAGER, Role.USER]) {
      expect(allOrgsInView(actor(role, { orgId: null }))).toBe(false);
    }
  });

  it('acting in an organisation sees it like X-Org-Id would, and nothing else', () => {
    const sm = actingIn(actor(Role.SUPER_MANAGER), ORG_B);
    const staffB = { id: 's', role: Role.USER, companyId: ORG_B, departmentId: null };
    const staffA = { ...staffB, companyId: ORG_A };
    expect(canSeePerson(sm, staffB)).toBe(true);
    expect(canSeePerson(sm, staffA)).toBe(false);
  });

  it('never widens anyone else', () => {
    const admin = actor(Role.ADMIN);
    expect(actingIn(admin, ORG_B)).toBe(admin);
  });
});

describe('withOrg / sumTotals', () => {
  it('tags a row and adds numbers up', () => {
    expect(withOrg({ id: 'p' }, { id: ORG_A, name: 'Acme' })).toEqual({
      id: 'p',
      companyId: ORG_A,
      companyName: 'Acme',
    });
    expect(
      sumTotals(
        [
          { a: 1, b: 2, flag: false },
          { a: 3, b: 4, flag: true },
        ],
        { a: 0, b: 0, flag: false },
      ),
    ).toEqual({ a: 4, b: 6, flag: true });
    expect(sumTotals([], { a: 0 })).toEqual({ a: 0 });
  });
});

describe('OrgsInViewService', () => {
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
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const svc = new OrgsInViewService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('All organisations: every live organisation, each run acting in it', async () => {
    const plan = await svc.plan(actor(Role.SUPER_MANAGER));
    expect(plan.combined).toBe(true);
    expect(plan.runs.map((r) => [r.org.name, r.me.orgId])).toEqual([
      ['Acme', ORG_A],
      ['Beta', ORG_B],
    ]);
    expect(prisma.company.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('All organisations with companyId: that one only; unknown or deleted is 404', async () => {
    const plan = await svc.plan(actor(Role.SUPER_ADMIN), ORG_B);
    expect(plan.combined).toBe(false);
    expect(plan.runs.map((r) => r.me.orgId)).toEqual([ORG_B]);
    await expect(
      svc.plan(actor(Role.SUPER_ADMIN), '33333333-3333-4333-8333-333333333333'),
    ).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it('inside one organisation: that organisation, the caller unchanged; another companyId is 404', async () => {
    const admin = actor(Role.ADMIN);
    const plan = await svc.plan(admin);
    expect(plan).toEqual({ combined: false, runs: [{ org: orgs[0], me: admin }] });
    await expect(svc.plan(admin, ORG_B)).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
    await expect(
      svc.plan(actor(Role.SUPER_ADMIN, { orgHeaderInvalid: true })),
    ).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
  });

  it('a department or manager filter on a combined view needs one organisation (400 ORG_REQUIRED)', async () => {
    await expect(
      svc.each(actor(Role.SUPER_MANAGER), undefined, async () => 1, { needsOneOrg: true }),
    ).rejects.toMatchObject({ status: 400, code: 'ORG_REQUIRED' });
    const one = await svc.each(actor(Role.SUPER_MANAGER), ORG_A, async (r) => r.org.name, {
      needsOneOrg: true,
    });
    expect(one.results.map((r) => r.value)).toEqual(['Acme']);
  });

  it("acts in a person's organisation only on All organisations", async () => {
    prisma.user.findFirst.mockResolvedValue({ companyId: ORG_B });
    const person = '44444444-4444-4444-8444-444444444444';
    expect((await svc.actingForPerson(actor(Role.SUPER_MANAGER), person)).orgId).toBe(ORG_B);
    const admin = actor(Role.ADMIN);
    expect(await svc.actingForPerson(admin, person)).toBe(admin);
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(svc.actingForPerson(actor(Role.SUPER_MANAGER), person)).rejects.toMatchObject({
      status: 404,
    });
  });
});
