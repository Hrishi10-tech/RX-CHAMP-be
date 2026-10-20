import {
  DEPT_A1,
  DEPT_A2,
  IDS,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { KEY_TTL_MS, hashPhrase, phraseMatches } from '../domain/signout-key.rules';
import { SignOutKeysService } from './signout-keys.service';

interface Key {
  id: string;
  companyId: string;
  phraseHash: string;
  salt: string;
  scope: string;
  userIds: string[];
  departmentIds: string[];
  createdById: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  uses: number;
}

const NOW = new Date('2026-10-19T09:00:00Z');
const PHRASE = 'amber orbit cedar river lamp 42';

function key(over: Partial<Key> & { phrase?: string } = {}): Key {
  const salt = '0123456789abcdef0123456789abcdef';
  return {
    id: over.id ?? '60000000-0000-0000-0000-000000000001',
    companyId: ORG_A,
    salt,
    phraseHash: hashPhrase(salt, over.phrase ?? PHRASE),
    scope: 'ORG',
    userIds: [],
    departmentIds: [],
    createdById: IDS.adminA,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + KEY_TTL_MS - 3_600_000),
    revokedAt: null,
    uses: 0,
    ...over,
  };
}

function setup(keys: Key[] = [], counts: { users?: number; departments?: number } = {}) {
  const store = keys.map((k) => ({ ...k }));
  const active = (k: Key, where: any) =>
    (where.companyId === undefined || k.companyId === where.companyId) &&
    (where.scope === undefined || k.scope === where.scope) &&
    (where.revokedAt !== null || k.revokedAt === null) &&
    (!where.expiresAt || k.expiresAt > where.expiresAt.gt);
  const prisma: any = {
    signOutKey: {
      findMany: jest.fn(async ({ where }: any) => store.filter((k) => active(k, where))),
      findFirst: jest.fn(
        async ({ where }: any) =>
          store.find((k) => k.id === where.id && k.companyId === where.companyId) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(store.find((k) => k.id === where.id)!, data),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const k = store.find((x) => x.id === where.id && active(x, where));
        if (!k) return { count: 0 };
        k.uses += data.uses.increment;
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          ...data,
          id: '60000000-0000-0000-0000-0000000000ff',
          revokedAt: null,
          uses: 0,
        };
        store.push(row);
        return row;
      }),
    },
    user: {
      count: jest.fn(async () => counts.users ?? 0),
      findMany: jest.fn(async () => [{ id: IDS.adminA, firstName: 'Asha', lastName: 'R' }]),
    },
    department: {
      count: jest.fn(async () => counts.departments ?? 0),
      findMany: jest.fn(async () => [{ id: DEPT_A1, name: 'Electronics' }]),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const audit = { record: jest.fn() };
  const refreshTokens = { revokeAgentSessions: jest.fn(async () => 1) };
  const users = { bumpEnrollVersion: jest.fn(async () => 2) };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const service = new SignOutKeysService(
    prisma,
    audit as any,
    refreshTokens as any,
    users as any,
    events as any,
  );
  return { service, prisma, audit, refreshTokens, users, events, store };
}

const actions = (audit: { record: jest.Mock }) => audit.record.mock.calls.map((c) => c[0].action);

describe('SignOutKeysService: issuing (Admin side)', () => {
  it.each([
    ['a Manager', manager([DEPT_A1])],
    ['Staff', staff()],
  ])('%s cannot list, issue or revoke keys (403)', async (_who, me) => {
    const { service } = setup([key()]);
    await expect(service.list(me, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(service.create(me, { scope: 'ORG' }, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(service.revoke(me, key().id, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it('a Super Admin needs an organisation selected (400 ORG_REQUIRED)', async () => {
    const { service } = setup();
    await expect(service.create(superAdmin(null), { scope: 'ORG' }, NOW)).rejects.toMatchObject({
      code: 'ORG_REQUIRED',
    });
  });

  it('issues an ORG key valid for 24 hours, storing only a salted hash; the phrase is shown once', async () => {
    const { service, store, audit } = setup();
    const created = await service.create(admin(ORG_A), { scope: 'ORG' }, NOW);
    expect(created.phrase).toMatch(/^[a-z]{3,8}( [a-z]{3,8}){4} [1-9]\d$/);
    expect(created.expiresAt).toBe(new Date(NOW.getTime() + KEY_TTL_MS).toISOString());
    const row = store[0];
    expect(row).toMatchObject({ companyId: ORG_A, scope: 'ORG', createdById: IDS.adminA });
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain(created.phrase);
    expect(phraseMatches(row, created.phrase)).toBe(true);
    expect(actions(audit)).toEqual(['SIGNOUT_KEY_CREATED']);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(created.phrase);
  });

  it('USERS and DEPARTMENTS keys must name people and departments of the organisation', async () => {
    const two = setup([], { users: 1, departments: 1 });
    await expect(
      two.service.create(
        admin(ORG_A),
        { scope: 'USERS', userIds: [IDS.staffA1, IDS.staffB1] },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'PERSON_NOT_FOUND' });
    await expect(
      two.service.create(
        admin(ORG_A),
        { scope: 'DEPARTMENTS', departmentIds: [DEPT_A1, DEPT_A2] },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'DEPARTMENT_NOT_FOUND' });
    await expect(
      two.service.create(admin(ORG_A), { scope: 'USERS', userIds: [] }, NOW),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      two.service.create(admin(ORG_A), { scope: 'ORG', userIds: [IDS.staffA1] }, NOW),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      two.service.create(admin(ORG_A), { scope: 'USERS', userIds: [IDS.staffA1] }, NOW),
    ).resolves.toMatchObject({ scope: 'USERS' });
  });

  it('lists keys with names, uses and whether still active', async () => {
    const { service } = setup([key({ scope: 'DEPARTMENTS', departmentIds: [DEPT_A1], uses: 3 })]);
    const [view] = await service.list(admin(ORG_A), NOW);
    expect(view).toMatchObject({
      scope: 'DEPARTMENTS',
      departments: [{ id: DEPT_A1, name: 'Electronics' }],
      createdBy: { id: IDS.adminA, name: 'Asha R' },
      uses: 3,
      active: true,
      revokedAt: null,
    });
    expect(view).not.toHaveProperty('phraseHash');
    expect(view).not.toHaveProperty('salt');
  });

  it("revokes a key; another organisation's key is not found", async () => {
    const { service, audit } = setup([key()]);
    await expect(service.revoke(admin(ORG_B), key().id, NOW)).rejects.toMatchObject({
      status: 404,
    });
    const view = await service.revoke(admin(ORG_A), key().id, NOW);
    expect(view).toMatchObject({ active: false, revokedAt: NOW.toISOString() });
    expect(actions(audit)).toEqual(['SIGNOUT_KEY_REVOKED']);
  });
});

describe('SignOutKeysService: the agent signing out', () => {
  it('a valid key ends the agent sessions and retires old installers', async () => {
    const { service, refreshTokens, users, store, audit, events } = setup([key()]);
    await expect(
      service.signOut(staff(), '  Amber ORBIT cedar river  lamp 42 ', NOW),
    ).resolves.toEqual({
      signedOut: true,
    });
    expect(refreshTokens.revokeAgentSessions).toHaveBeenCalledWith(IDS.staffA1);
    expect(users.bumpEnrollVersion).toHaveBeenCalledWith(IDS.staffA1);
    expect(store[0].uses).toBe(1);
    expect(actions(audit)).toEqual(['SIGNOUT_KEY_USED']);
    expect(events.publish).toHaveBeenCalledWith(
      'agent.signed-out',
      expect.objectContaining({ userId: IDS.staffA1 }),
    );
    // Not a UserAccessChangedEvent SIGN_OUT: that would end the portal session too.
    expect(events.publish).not.toHaveBeenCalledWith('user.access-changed', expect.anything());
  });

  it('a wrong phrase answers 403 SIGNOUT_KEY_INVALID and is audited', async () => {
    const { service, refreshTokens, audit } = setup([key()]);
    await expect(
      service.signOut(staff(), 'amber orbit cedar river lamp 43', NOW),
    ).rejects.toMatchObject({
      status: 403,
      code: 'SIGNOUT_KEY_INVALID',
    });
    expect(refreshTokens.revokeAgentSessions).not.toHaveBeenCalled();
    expect(actions(audit)).toEqual(['SIGNOUT_KEY_FAILED']);
  });

  it('only keys whose scope covers the person work', async () => {
    const usersKey = key({ scope: 'USERS', userIds: [IDS.staffA2] });
    const deptKey = key({
      id: '60000000-0000-0000-0000-000000000002',
      scope: 'DEPARTMENTS',
      departmentIds: [DEPT_A2],
      phrase: 'acorn able about above absent 77',
    });
    const { service } = setup([usersKey, deptKey]);
    await expect(service.signOut(staff(DEPT_A1), PHRASE, NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
    await expect(service.signOut(staff(DEPT_A2), PHRASE, NOW)).resolves.toEqual({
      signedOut: true,
    });
    await expect(
      service.signOut(staff(DEPT_A1), 'acorn able about above absent 77', NOW),
    ).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
    // A Manager is covered through any department they manage.
    await expect(
      service.signOut(manager([DEPT_A1, DEPT_A2]), 'acorn able about above absent 77', NOW),
    ).resolves.toEqual({
      signedOut: true,
    });
  });

  it("another organisation's key never works", async () => {
    const { service } = setup([key({ companyId: ORG_B })]);
    await expect(service.signOut(staff(), PHRASE, NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
  });

  it('expired and revoked keys do not work', async () => {
    const expired = setup([key({ expiresAt: new Date(NOW.getTime() - 1) })]);
    await expect(expired.service.signOut(staff(), PHRASE, NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
    const revoked = setup([key({ revokedAt: new Date(NOW.getTime() - 60_000) })]);
    await expect(revoked.service.signOut(staff(), PHRASE, NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
  });

  it('a key revoked between the check and the use is not used', async () => {
    const { service, prisma, refreshTokens } = setup([key()]);
    prisma.signOutKey.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.signOut(staff(), PHRASE, NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
    expect(refreshTokens.revokeAgentSessions).not.toHaveBeenCalled();
  });

  it('5 wrong keys in 10 minutes, then 429 TOO_MANY_ATTEMPTS, even with the right key', async () => {
    const { service } = setup([key()]);
    for (let i = 0; i < 5; i++) {
      await expect(
        service.signOut(staff(), `wrong ${i}`, new Date(NOW.getTime() + i * 1000)),
      ).rejects.toMatchObject({
        status: 403,
      });
    }
    await expect(
      service.signOut(staff(), PHRASE, new Date(NOW.getTime() + 6000)),
    ).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_ATTEMPTS',
    });
    // Someone else is unaffected, and the person can try again after 10 minutes.
    await expect(
      service.signOut(staff(DEPT_A2), PHRASE, new Date(NOW.getTime() + 6000)),
    ).resolves.toEqual({
      signedOut: true,
    });
    await expect(
      service.signOut(staff(), PHRASE, new Date(NOW.getTime() + 601_000)),
    ).resolves.toEqual({
      signedOut: true,
    });
  });

  it('a Super Admin agent uses an organisation-wide key of any organisation', async () => {
    const { service } = setup([key({ companyId: ORG_B })]);
    await expect(service.signOut(superAdmin(null), PHRASE, NOW)).resolves.toEqual({
      signedOut: true,
    });
  });
});

describe('SignOutKeysService: quitting', () => {
  it('Admins and Super Admins may quit with a valid key, without signing out', async () => {
    const { service, refreshTokens, users, audit } = setup([key()]);
    await expect(service.quitCheck(admin(ORG_A), PHRASE, NOW)).resolves.toEqual({ allowed: true });
    expect(refreshTokens.revokeAgentSessions).not.toHaveBeenCalled();
    expect(users.bumpEnrollVersion).not.toHaveBeenCalled();
    expect(actions(audit)).toEqual(['QUIT_KEY_USED']);
  });

  it('Managers and Staff cannot quit (403 QUIT_NOT_ALLOWED)', async () => {
    const { service } = setup([key()]);
    await expect(service.quitCheck(manager([DEPT_A1]), PHRASE, NOW)).rejects.toMatchObject({
      code: 'QUIT_NOT_ALLOWED',
    });
    await expect(service.quitCheck(staff(), PHRASE, NOW)).rejects.toMatchObject({
      code: 'QUIT_NOT_ALLOWED',
    });
  });

  it('a wrong key is refused and audited', async () => {
    const { service, audit } = setup([key()]);
    await expect(service.quitCheck(admin(ORG_A), 'nope', NOW)).rejects.toMatchObject({
      code: 'SIGNOUT_KEY_INVALID',
    });
    expect(actions(audit)).toEqual(['QUIT_KEY_FAILED']);
  });
});
