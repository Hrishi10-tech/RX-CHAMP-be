import { OrganisationChangedEvent } from '@shared/events/organisation-changed.event';
import { requireOrg } from '@shared/tenancy';
import { PrismaAuthUserReader } from './prisma-auth-user-reader';

/**
 * 4.0 (audit L4): a deleted organisation is not found, for a Super Admin's
 * X-Org-Id and for someone still in it, and the X-Org-Id cache forgets it.
 */
const ORG = '11111111-1111-4111-8111-111111111111';

function row(role: string, companyDeletedAt: Date | null = null) {
  return {
    id: `${role}-1`,
    email: `${role}@x.test`,
    role: { name: role, permissions: [] },
    department: null,
    companyId: role === 'SUPER_ADMIN' ? null : ORG,
    company: role === 'SUPER_ADMIN' ? null : { deletedAt: companyDeletedAt },
    status: 'ACTIVE',
    departmentId: null,
    grantScreenshots: false,
    grantTimeline: false,
    grantActivity: false,
    managedDepartments: [],
  };
}

function setup() {
  const handlers: ((e: OrganisationChangedEvent) => void)[] = [];
  const prisma = {
    user: { findFirst: jest.fn() },
    company: { findFirst: jest.fn() },
  };
  const events = {
    subscribe: jest.fn((_name: string, fn: (e: OrganisationChangedEvent) => void) =>
      handlers.push(fn),
    ),
    publish: jest.fn(),
  };
  const reader = new PrismaAuthUserReader(prisma as never, events as never);
  reader.onModuleInit();
  const changed = (change: 'DELETED' | 'CREATED') =>
    handlers.forEach((h) => h(new OrganisationChangedEvent(ORG, change, new Date())));
  return { reader, prisma, changed };
}

describe('PrismaAuthUserReader and deleted organisations', () => {
  it('someone left in a deleted organisation acts in none (404 ORG_NOT_FOUND)', async () => {
    const { reader, prisma } = setup();
    prisma.user.findFirst.mockResolvedValue(row('USER', new Date('2026-10-19T00:00:00Z')));
    const me = (await reader.loadById('USER-1'))!;
    expect(me).toMatchObject({ orgId: null, orgDeleted: true, companyId: ORG });
    expect(() => requireOrg(me)).toThrow(
      expect.objectContaining({ status: 404, code: 'ORG_NOT_FOUND' }),
    );
    prisma.user.findFirst.mockResolvedValue(row('ADMIN'));
    expect(requireOrg((await reader.loadById('ADMIN-1'))!)).toBe(ORG);
  });

  it("a Super Admin's X-Org-Id of a deleted organisation is not found, as soon as it is deleted", async () => {
    const { reader, prisma, changed } = setup();
    prisma.user.findFirst.mockResolvedValue(row('SUPER_ADMIN'));
    prisma.company.findFirst.mockResolvedValueOnce({ id: ORG });
    expect((await reader.loadById('sa', ORG))!.orgId).toBe(ORG);
    // Cached for a while ...
    expect((await reader.loadById('sa', ORG))!.orgId).toBe(ORG);
    expect(prisma.company.findFirst).toHaveBeenCalledTimes(1);
    // ... until the organisation changes.
    changed('DELETED');
    prisma.company.findFirst.mockResolvedValueOnce(null);
    const after = (await reader.loadById('sa', ORG))!;
    expect(after.orgHeaderInvalid).toBe(true);
    expect(() => requireOrg(after)).toThrow(expect.objectContaining({ code: 'ORG_NOT_FOUND' }));
  });

  it('a lookup that began before the organisation changed is not cached', async () => {
    const { reader, prisma, changed } = setup();
    prisma.user.findFirst.mockResolvedValue(row('SUPER_ADMIN'));
    let release!: (v: unknown) => void;
    prisma.company.findFirst.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const pending = reader.loadById('sa', ORG);
    await new Promise((r) => setImmediate(r));
    changed('DELETED'); // the delete commits while the lookup is in flight
    release({ id: ORG });
    expect((await pending)!.orgId).toBe(ORG);
    prisma.company.findFirst.mockResolvedValueOnce(null);
    expect((await reader.loadById('sa', ORG))!.orgHeaderInvalid).toBe(true);
  });
});
