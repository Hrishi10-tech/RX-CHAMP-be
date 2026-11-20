import { Role } from '@shared/rbac/roles.enum';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';
import { EnrollAgentUseCase } from './enroll-agent.use-case';

const meta = { userAgent: 'RXVisionAgent/4.0.2 (windows)', ip: '127.0.0.1' };
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function person(
  id: string,
  role: Role,
  over: { status?: 'ACTIVE' | 'DISABLED'; enrollVersion?: number; companyId?: string } = {},
): User {
  return User.fromPersistence({
    id: UserId.create(id),
    email: Email.create(`${id}@rx.test`),
    passwordHash: 'hash',
    firstName: id,
    lastName: '',
    designation: null,
    role,
    department: null,
    managerId: null,
    companyId: over.companyId ?? ORG,
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status: over.status ?? 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: new Date(),
    createdAt: new Date(),
    departmentId: role === Role.USER ? 'd1' : null,
    enrollVersion: over.enrollVersion ?? 1,
  });
}

/** The minter as AuthUserReader.loadById answers: the signed-in shape, in the subject's organisation. */
function actor(id: string, role: Role, over: { status?: string; orgId?: string | null } = {}) {
  return {
    id,
    email: `${id}@rx.test`,
    role,
    permissions: [],
    department: null,
    companyId: role === Role.SUPER_ADMIN ? null : ORG,
    status: over.status ?? 'ACTIVE',
    orgId: over.orgId === undefined ? ORG : over.orgId,
    departmentId: null,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    grants: undefined,
    authEpoch: 0,
  };
}

type Claims = { userId: string; enrollVersion: number; epoch: number; mintedBy: string | null };

/**
 * The exchange as the API sees it: `people` is the users table now, `minters` what
 * AuthUserReader answers for each minter, `epochs` the stored auth epochs (0 when not
 * listed), `claims` what the presented token says.
 */
function setup(
  people: User[],
  claims: Claims,
  minters: Record<string, ReturnType<typeof actor> | null> = {},
  epochs: Record<string, number> = {},
) {
  const users = {
    findById: jest.fn(async (id: string) => people.find((p) => p.id === id) ?? null),
    authEpochOf: jest.fn(async (id: string) =>
      people.some((p) => p.id === id) ? (epochs[id] ?? 0) : null,
    ),
    markAgentActivatedIfFirst: jest.fn().mockResolvedValue(false),
  };
  const tokens = {
    verifyEnrollmentToken: jest.fn().mockResolvedValue(claims),
    signAccessToken: jest.fn().mockResolvedValue('access'),
  };
  const refreshTokens = { issue: jest.fn().mockResolvedValue({ token: 'refresh' }) };
  const events = { publish: jest.fn() };
  const authUsers = { loadById: jest.fn(async (id: string) => minters[id] ?? null) };
  const useCase = new EnrollAgentUseCase(
    users as never,
    tokens as never,
    refreshTokens as never,
    events as never,
    authUsers as never,
  );
  return { useCase, tokens, refreshTokens, authUsers };
}

const refused = { status: 401, code: 'INVALID_CREDENTIALS' };

/** 3.6 (F-02, F-03) on 4.0: a token stands only while its version, its epoch and its minter do. */
describe('EnrollAgentUseCase: version, epoch and minter', () => {
  const staff = person('s-1', Role.USER, { enrollVersion: 3 });
  const byAdmin: Claims = { userId: 's-1', enrollVersion: 3, epoch: 2, mintedBy: 'a-1' };

  it("control: the organisation's Admin minted it and nothing changed since", async () => {
    const { useCase, tokens, authUsers } = setup(
      [staff],
      byAdmin,
      { 'a-1': actor('a-1', Role.ADMIN) },
      { 's-1': 2 },
    );
    await expect(useCase.execute('token', meta)).resolves.toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    // The minter is read acting in the subject's organisation.
    expect(authUsers.loadById).toHaveBeenCalledWith('a-1', ORG);
    // The new session carries the current epoch.
    expect(tokens.signAccessToken).toHaveBeenCalledWith(expect.objectContaining({ ep: 2 }));
  });

  it('4.0: refused once the enrollVersion moved on (key sign-out, credential reset)', async () => {
    const { useCase } = setup(
      [person('s-1', Role.USER, { enrollVersion: 4 })],
      byAdmin,
      { 'a-1': actor('a-1', Role.ADMIN) },
      { 's-1': 2 },
    );
    await expect(useCase.execute('token', meta)).rejects.toMatchObject(refused);
  });

  it("refused once the person's auth epoch moved (sign out everywhere, a block, a role change)", async () => {
    const { useCase, refreshTokens } = setup(
      [staff],
      byAdmin,
      { 'a-1': actor('a-1', Role.ADMIN) },
      { 's-1': 3 },
    );
    await expect(useCase.execute('token', meta)).rejects.toMatchObject(refused);
    expect(refreshTokens.issue).not.toHaveBeenCalled();
  });

  it('refused once its minter is blocked or gone', async () => {
    for (const minter of [actor('a-1', Role.ADMIN, { status: 'DISABLED' }), null]) {
      const { useCase } = setup([staff], byAdmin, { 'a-1': minter }, { 's-1': 2 });
      await expect(useCase.execute('token', meta)).rejects.toMatchObject(refused);
    }
  });

  it('refused once its minter could no longer issue it (now Staff, or now in another organisation)', async () => {
    for (const minter of [actor('a-1', Role.USER), actor('a-1', Role.ADMIN, { orgId: OTHER })]) {
      const { useCase } = setup([staff], byAdmin, { 'a-1': minter }, { 's-1': 2 });
      await expect(useCase.execute('token', meta)).rejects.toMatchObject(refused);
    }
  });

  it('a Super Admin minter is judged in the subject organisation', async () => {
    const { useCase } = setup(
      [person('a-2', Role.ADMIN)],
      { userId: 'a-2', enrollVersion: 1, epoch: 0, mintedBy: 'sa-1' },
      { 'sa-1': actor('sa-1', Role.SUPER_ADMIN) },
    );
    await expect(useCase.execute('token', meta)).resolves.toMatchObject({ accessToken: 'access' });
  });

  it('a token from before 3.6 (no epoch, no minter) keeps working until the first raise', async () => {
    const old: Claims = { userId: 's-1', enrollVersion: 3, epoch: 0, mintedBy: null };
    const ok = setup([staff], old);
    await expect(ok.useCase.execute('token', meta)).resolves.toMatchObject({
      accessToken: 'access',
    });
    expect(ok.authUsers.loadById).not.toHaveBeenCalled();

    const raised = setup([staff], old, {}, { 's-1': 1 });
    await expect(raised.useCase.execute('token', meta)).rejects.toMatchObject(refused);
  });

  it('a token for someone who is gone is refused', async () => {
    const { useCase } = setup([], byAdmin, { 'a-1': actor('a-1', Role.ADMIN) });
    await expect(useCase.execute('token', meta)).rejects.toMatchObject(refused);
  });
});
