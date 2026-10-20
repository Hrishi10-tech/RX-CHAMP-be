import { OrganisationChangedEvent } from '@shared/events/organisation-changed.event';
import {
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { nameTaken, orgNameProblem } from '../domain/organisation.rules';
import { OrgPerson, OrgRecord, OrganisationStore } from '../domain/organisation.store';
import { OrganisationsService } from './organisations.service';

function fakeStore(over: Partial<Record<keyof OrganisationStore, jest.Mock>> = {}) {
  const orgs: OrgRecord[] = [
    { id: ORG_A, name: 'Xelements', createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: ORG_B, name: 'RhythmRx', createdAt: new Date('2026-02-01T00:00:00Z') },
  ];
  const people: OrgPerson[] = [];
  let adminOf = new Set<string>([ORG_A]);
  const store: Record<keyof OrganisationStore, jest.Mock> = {
    list: jest.fn(async () => orgs),
    findById: jest.fn(async (id: string) => orgs.find((o) => o.id === id) ?? null),
    create: jest.fn(async (name: string) =>
      nameTaken(orgs, name)
        ? { ok: false as const, reason: 'NAME_TAKEN' as const }
        : { ok: true as const, org: { id: 'new-org', name, createdAt: new Date() } },
    ),
    rename: jest.fn(async (id: string, name: string) => {
      const org = orgs.find((o) => o.id === id);
      if (!org) return { ok: false as const, reason: 'NOT_FOUND' as const };
      if (nameTaken(orgs, name, id)) return { ok: false as const, reason: 'NAME_TAKEN' as const };
      return { ok: true as const, org: { ...org, name } };
    }),
    countActivePeople: jest.fn(async () => 0),
    softDelete: jest.fn(async () => ({ ok: true as const, membersRemoved: 1 })),
    admins: jest.fn(
      async () =>
        new Map([
          [ORG_A, { id: 'adm', name: 'Asha R', email: 'a@x.io', status: 'ACTIVE' as const }],
        ]),
    ),
    counts: jest.fn(async () => new Map([[ORG_A, { staff: 4, managers: 1, departments: 2 }]])),
    today: jest.fn(
      async () => new Map([[ORG_A, { started: 3, working: 2, onBreak: 1, notStarted: 2 }]]),
    ),
    listUnassigned: jest.fn(async () => people.filter((p) => !p.companyId)),
    countUnassigned: jest.fn(async () => 7),
    findPerson: jest.fn(async (id: string) => people.find((p) => p.id === id) ?? null),
    createAdmin: jest.fn(
      async (data: { companyId: string; email: string; firstName: string; lastName: string }) =>
        adminOf.has(data.companyId)
          ? { ok: false as const, reason: 'ADMIN_EXISTS' as const }
          : {
              ok: true as const,
              admin: {
                id: 'new-admin',
                email: data.email,
                firstName: data.firstName,
                lastName: data.lastName,
                status: 'ACTIVE' as const,
                companyId: data.companyId,
                createdAt: new Date(),
              },
            },
    ),
    hasAdmin: jest.fn(async (id: string) => adminOf.has(id)),
    assignPerson: jest.fn(async () => ({ ok: true as const, changed: true })),
    ...over,
  };
  return { store, people, setAdmins: (ids: string[]) => (adminOf = new Set(ids)) };
}

function setup(over: Partial<Record<keyof OrganisationStore, jest.Mock>> = {}) {
  const fake = fakeStore(over);
  const hasher = { hash: jest.fn(async () => 'hashed'), compare: jest.fn() };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const settings = { forgetUser: jest.fn() };
  const service = new OrganisationsService(
    fake.store as unknown as OrganisationStore,
    hasher,
    events as any,
    settings as any,
  );
  return { ...fake, service, hasher, events, settings };
}

describe('organisation name rules', () => {
  it.each([
    ['A', /at least 2/],
    ['x'.repeat(81), /80 characters/],
    [42, /Name the organisation/],
  ])('refuses %p', (name, message) => {
    expect(orgNameProblem(name)).toMatch(message);
  });

  it('compares names ignoring case and spacing', () => {
    expect(nameTaken([{ id: '1', name: 'Rhythm  RX' }], ' rhythm rx ')).toBe(true);
    expect(nameTaken([{ id: '1', name: 'Rhythm RX' }], 'Rhythm RX', '1')).toBe(false);
  });
});

describe('OrganisationsService scope: Super Admin only', () => {
  const others = [
    ['Admin', admin(ORG_A)],
    ['Manager', manager()],
    ['Staff', staff()],
  ] as const;

  it.each(others)('%s cannot list, create, rename, delete or create an Admin', async (_who, me) => {
    const { service, store } = setup();
    await expect(service.list(me)).rejects.toMatchObject({ status: 403 });
    await expect(service.platformOverview(me)).rejects.toMatchObject({ status: 403 });
    await expect(service.create(me, 'New org')).rejects.toMatchObject({ status: 403 });
    await expect(service.rename(me, ORG_A, 'New org')).rejects.toMatchObject({ status: 403 });
    await expect(service.remove(me, ORG_A)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.createAdmin(me, ORG_B, {
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.io',
        password: 'longenough',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.assignPerson(me, ORG_A, 'p')).rejects.toMatchObject({ status: 403 });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.softDelete).not.toHaveBeenCalled();
  });

  it('works for a Super Admin with or without a selected organisation', async () => {
    const { service } = setup();
    expect(await service.list(superAdmin())).toHaveLength(2);
    expect(await service.list(superAdmin(ORG_B))).toHaveLength(2);
  });
});

describe('OrganisationsService', () => {
  const sa = superAdmin();

  it('lists each organisation with its admin, counts and today', async () => {
    const { service, store } = setup();
    const list = await service.list(sa, new Date('2026-10-19T06:00:00Z'));
    expect(list[0]).toEqual({
      id: ORG_A,
      name: 'Xelements',
      createdAt: '2026-01-01T00:00:00.000Z',
      admin: { id: 'adm', name: 'Asha R', email: 'a@x.io', status: 'ACTIVE' },
      counts: { staff: 4, managers: 1, departments: 2 },
      today: { started: 3, working: 2, onBreak: 1, notStarted: 2 },
    });
    expect(list[1]).toMatchObject({
      admin: null,
      counts: { staff: 0, managers: 0, departments: 0 },
      today: { started: 0, working: 0, onBreak: 0, notStarted: 0 },
    });
    // "today" is the business day (Asia/Kolkata by default): 11:30 AM on the 19th.
    expect(store.today).toHaveBeenCalledWith([ORG_A, ORG_B], '2026-10-19');
  });

  it('platform overview adds the people needing an organisation', async () => {
    const { service } = setup();
    const view = await service.platformOverview(sa);
    expect(view.unassignedPeople).toBe(7);
    expect(view.organisations).toHaveLength(2);
  });

  it('creates with a normalised name and announces it', async () => {
    const { service, store, events } = setup();
    const org = await service.create(sa, '  New   Org ');
    expect(store.create).toHaveBeenCalledWith('New Org', sa.id);
    expect(org.name).toBe('New Org');
    expect(events.publish).toHaveBeenCalledWith(
      OrganisationChangedEvent.eventName,
      expect.objectContaining({ companyId: 'new-org', change: 'CREATED' }),
    );
  });

  it('refuses a duplicate name ignoring case (409 ORG_EXISTS) and a bad length (400)', async () => {
    const { service } = setup();
    await expect(service.create(sa, 'XELEMENTS')).rejects.toMatchObject({
      status: 409,
      code: 'ORG_EXISTS',
    });
    await expect(service.create(sa, 'X')).rejects.toMatchObject({ status: 400 });
    await expect(service.rename(sa, ORG_B, 'xelements')).rejects.toMatchObject({ status: 409 });
    await expect(service.rename(sa, ORG_B, 'rhythmrx')).resolves.toMatchObject({
      name: 'rhythmrx',
    });
  });

  it('refuses to delete while active people remain (409 ORG_NOT_EMPTY)', async () => {
    const { service, store } = setup({ countActivePeople: jest.fn(async () => 3) });
    await expect(service.remove(sa, ORG_A)).rejects.toMatchObject({
      status: 409,
      code: 'ORG_NOT_EMPTY',
      details: { activePeople: 3 },
    });
    expect(store.softDelete).not.toHaveBeenCalled();
  });

  it('someone added while the delete waited for the row lock: counted there and refused (409)', async () => {
    const { service, store, events } = setup({
      softDelete: jest.fn(async () => ({
        ok: false as const,
        reason: 'NOT_EMPTY' as const,
        active: 1,
      })),
    });
    await expect(service.remove(sa, ORG_B)).rejects.toMatchObject({
      status: 409,
      code: 'ORG_NOT_EMPTY',
      details: { activePeople: 1 },
    });
    expect(store.softDelete).toHaveBeenCalledWith(ORG_B, sa.id);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('an organisation deleted meanwhile is not found (404)', async () => {
    const { service } = setup({
      softDelete: jest.fn(async () => ({ ok: false as const, reason: 'NOT_FOUND' as const })),
    });
    await expect(service.remove(sa, ORG_B)).rejects.toMatchObject({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
  });

  it('deletes an empty organisation and tells the X-Org-Id cache', async () => {
    const { service, events } = setup();
    await expect(service.remove(sa, ORG_B)).resolves.toEqual({
      deleted: true,
      id: ORG_B,
      name: 'RhythmRx',
      membersRemoved: 1,
    });
    expect(events.publish).toHaveBeenCalledWith(
      OrganisationChangedEvent.eventName,
      expect.objectContaining({ companyId: ORG_B, change: 'DELETED' }),
    );
  });

  it('answers 404 for an unknown organisation', async () => {
    const { service } = setup();
    const missing = '00000000-0000-0000-0000-0000000000ff';
    await expect(service.remove(sa, missing)).rejects.toMatchObject({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
    await expect(service.rename(sa, missing, 'Fine name')).rejects.toMatchObject({ status: 404 });
    await expect(
      service.createAdmin(sa, missing, {
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.io',
        password: 'longenough',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('OrganisationsService: the one Admin', () => {
  const sa = superAdmin();
  const input = {
    firstName: ' Ravi ',
    lastName: 'K',
    email: ' Ravi@Example.COM ',
    password: 'S3cure!pass',
  };

  it('creates the Admin with a hashed password and a lowercased email', async () => {
    const { service, store, hasher } = setup();
    const created = await service.createAdmin(sa, ORG_B, input);
    expect(hasher.hash).toHaveBeenCalledWith('S3cure!pass');
    expect(store.createAdmin).toHaveBeenCalledWith(
      {
        companyId: ORG_B,
        email: 'ravi@example.com',
        passwordHash: 'hashed',
        firstName: 'Ravi',
        lastName: 'K',
      },
      sa.id,
    );
    expect(created).toMatchObject({ role: 'ADMIN', companyId: ORG_B, name: 'Ravi K' });
    expect(JSON.stringify(created)).not.toContain('S3cure');
  });

  it('refuses a second Admin (409 ADMIN_EXISTS)', async () => {
    const { service, hasher } = setup();
    await expect(service.createAdmin(sa, ORG_A, input)).rejects.toMatchObject({
      status: 409,
      code: 'ADMIN_EXISTS',
    });
    expect(hasher.hash).not.toHaveBeenCalled();
  });

  it('reports an address in use without saying where (409 EMAIL_IN_USE)', async () => {
    const { service } = setup({
      createAdmin: jest.fn(async () => ({ ok: false as const, reason: 'EMAIL_IN_USE' as const })),
    });
    const err = await service.createAdmin(sa, ORG_B, input).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
    expect(err.message).toBe('That email address is already in use.');
  });

  it('refuses a short password and a bad email', async () => {
    const { service } = setup();
    await expect(
      service.createAdmin(sa, ORG_B, { ...input, password: 'short' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'WEAK_PASSWORD',
    });
    await expect(service.createAdmin(sa, ORG_B, { ...input, email: 'nope' })).rejects.toMatchObject(
      { status: 400 },
    );
  });
});

describe('OrganisationsService: people with no organisation', () => {
  const sa = superAdmin();
  const person = (over: Partial<OrgPerson>): OrgPerson => ({
    id: 'p1',
    firstName: 'Meena',
    lastName: 'S',
    email: 'm@x.io',
    role: 'USER',
    status: 'ACTIVE',
    companyId: null,
    ...over,
  });

  it('puts an unassigned person into an organisation and refreshes their access', async () => {
    const { service, people, store, events, settings } = setup();
    people.push(person({}));
    await expect(service.assignPerson(sa, ORG_B, 'p1')).resolves.toEqual({
      id: 'p1',
      companyId: ORG_B,
      role: 'USER',
      changed: true,
    });
    expect(store.assignPerson).toHaveBeenCalledWith('p1', ORG_B, sa.id);
    expect(settings.forgetUser).toHaveBeenCalledWith('p1');
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: 'p1', changes: ['ROLE'] }),
    );
  });

  it('refuses to move someone from another organisation (409 PERSON_IN_ORGANISATION)', async () => {
    const { service, people, store } = setup();
    people.push(person({ companyId: ORG_A }));
    await expect(service.assignPerson(sa, ORG_B, 'p1')).rejects.toMatchObject({
      status: 409,
      code: 'PERSON_IN_ORGANISATION',
    });
    expect(store.assignPerson).not.toHaveBeenCalled();
  });

  it('is a no-op for someone already there', async () => {
    const { service, people, store } = setup();
    people.push(person({ companyId: ORG_B }));
    await expect(service.assignPerson(sa, ORG_B, 'p1')).resolves.toMatchObject({ changed: false });
    expect(store.assignPerson).not.toHaveBeenCalled();
  });

  it('what the store finds under the row lock wins: a deleted organisation, a second Admin', async () => {
    const { service, people, store, events } = setup();
    people.push(person({}));
    store.assignPerson.mockResolvedValueOnce({ ok: false, reason: 'ORG_NOT_FOUND' } as never);
    await expect(service.assignPerson(sa, ORG_B, 'p1')).rejects.toMatchObject({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
    store.assignPerson.mockResolvedValueOnce({ ok: false, reason: 'ADMIN_EXISTS' } as never);
    await expect(service.assignPerson(sa, ORG_B, 'p1')).rejects.toMatchObject({
      status: 409,
      code: 'ADMIN_EXISTS',
    });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('never assigns a Super Admin, and keeps one Admin per organisation', async () => {
    const { service, people } = setup();
    people.push(person({ id: 'sa2', role: 'SUPER_ADMIN' }), person({ id: 'adm2', role: 'ADMIN' }));
    await expect(service.assignPerson(sa, ORG_B, 'sa2')).rejects.toMatchObject({ status: 404 });
    await expect(service.assignPerson(sa, ORG_A, 'adm2')).rejects.toMatchObject({
      code: 'ADMIN_EXISTS',
    });
  });
});
