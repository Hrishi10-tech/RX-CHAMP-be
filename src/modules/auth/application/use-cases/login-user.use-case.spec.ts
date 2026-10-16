import { Role } from '@shared/rbac/roles.enum';
import { AccountDisabledError, InvalidCredentialsError } from '@shared/exceptions/app.exception';
import { FailedLoginsByAddress } from '../failed-logins-by-address.service';
import { LoginAttempts } from '../login-attempts.service';
import { LoginUserUseCase } from './login-user.use-case';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';

function buildUser(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): User {
  return User.fromPersistence({
    id: UserId.create('u-1'),
    email: Email.create('admin@timechamp.test'),
    passwordHash: 'stored-hash',
    firstName: 'Praveen',
    lastName: '',
    designation: null,
    role: Role.SUPER_ADMIN,
    department: null,
    managerId: null,
    companyId: 'c-1',
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status,
    screenshotsEnabled: true,
    agentActivatedAt: null,
    createdAt: new Date(),
  });
}

describe('LoginUserUseCase', () => {
  const users = { findByEmail: jest.fn(), markAgentActivatedIfFirst: jest.fn() } as any;
  const hasher = { compare: jest.fn(), hash: jest.fn() } as any;
  const tokens = { signAccessToken: jest.fn() } as any;
  const refreshTokens = {
    issue: jest.fn(),
    rotate: jest.fn(),
    revoke: jest.fn(),
    signedInFrom: jest.fn().mockResolvedValue(false),
  } as any;
  const meta = { userAgent: 'jest', ip: '127.0.0.1' };

  let useCase: LoginUserUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new LoginUserUseCase(users, hasher, tokens, refreshTokens);
  });

  it('rejects an unknown email', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(useCase.execute('nope@x.test', 'pw', meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('tells a blocked account it is blocked, once the password checks out', async () => {
    users.findByEmail.mockResolvedValue(buildUser('DISABLED'));
    hasher.compare.mockResolvedValue(true);

    const err = await useCase.execute('admin@timechamp.test', 'admin123', meta).catch((e) => e);

    expect(err).toBeInstanceOf(AccountDisabledError);
    expect(err.code).toBe('ACCOUNT_DISABLED');
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/blocked/i);
  });

  it('rejects a wrong password', async () => {
    users.findByEmail.mockResolvedValue(buildUser());
    hasher.compare.mockResolvedValue(false);
    await expect(useCase.execute('admin@timechamp.test', 'wrong', meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('does not reveal blocked status to someone with the wrong password', async () => {
    users.findByEmail.mockResolvedValue(buildUser('DISABLED'));
    hasher.compare.mockResolvedValue(false);

    await expect(useCase.execute('admin@timechamp.test', 'wrong', meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('returns the public user + access/refresh tokens on success', async () => {
    users.findByEmail.mockResolvedValue(buildUser());
    hasher.compare.mockResolvedValue(true);
    tokens.signAccessToken.mockResolvedValue('signed.jwt.token');
    refreshTokens.issue.mockResolvedValue({ token: 'raw.refresh.token', expiresAt: new Date() });

    const result = await useCase.execute('admin@timechamp.test', 'admin123', meta);
    expect(result.user.email).toBe('admin@timechamp.test');
    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.refreshToken).toBe('raw.refresh.token');
    expect(tokens.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'u-1',
        email: 'admin@timechamp.test',
        role: Role.SUPER_ADMIN,
      }),
    );
    expect(refreshTokens.issue).toHaveBeenCalledWith('u-1', meta);

    expect(result.user as unknown as Record<string, unknown>).not.toHaveProperty('passwordHash');
  });

  describe('agent activation', () => {
    const events = { publish: jest.fn() } as any;
    const signedIn = () => {
      const user = buildUser();
      users.findByEmail.mockResolvedValue(user);
      hasher.compare.mockResolvedValue(true);
      tokens.signAccessToken.mockResolvedValue('access');
      refreshTokens.issue.mockResolvedValue({ token: 'refresh' });
      return new LoginUserUseCase(users, hasher, tokens, refreshTokens, undefined, events);
    };

    it('marks the agent activated when the desktop agent signs in with a password', async () => {
      users.markAgentActivatedIfFirst.mockResolvedValue(true);
      await signedIn().execute('admin@timechamp.test', 'admin123', {
        userAgent: 'RXVisionAgent/3.0.0 (mac)',
        ip: null,
      });
      expect(users.markAgentActivatedIfFirst).toHaveBeenCalledWith('u-1');
    });

    it('leaves activation alone for a browser sign-in', async () => {
      await signedIn().execute('admin@timechamp.test', 'admin123', {
        userAgent: 'Mozilla/5.0',
        ip: null,
      });
      expect(users.markAgentActivatedIfFirst).not.toHaveBeenCalled();
    });

    it('never fails the sign-in over the activation stamp', async () => {
      users.markAgentActivatedIfFirst.mockRejectedValue(new Error('db down'));
      const res = await signedIn().execute('admin@timechamp.test', 'admin123', {
        userAgent: 'RXVisionAgent/3.0.0 (windows)',
        ip: null,
      });
      expect(res.accessToken).toBe('access');
    });
  });

  describe('failed sign-ins per client address', () => {
    const office = { userAgent: 'Mozilla/5.0', ip: '203.0.113.7' };
    let byAddress: FailedLoginsByAddress;
    let guarded: LoginUserUseCase;
    beforeEach(() => {
      byAddress = new FailedLoginsByAddress();
      guarded = new LoginUserUseCase(
        users,
        hasher,
        tokens,
        refreshTokens,
        new LoginAttempts(),
        undefined,
        byAddress,
      );
      users.findByEmail.mockResolvedValue(buildUser());
      tokens.signAccessToken.mockResolvedValue('access');
      refreshTokens.issue.mockResolvedValue({ token: 'refresh' });
    });

    const spray = async (n: number) => {
      hasher.compare.mockResolvedValue(false);
      for (let i = 0; i < n; i++) {
        // One guess per account: the per-account lockout never trips.
        await guarded.execute(`person${i}@x.test`, 'Winter2026!', office).catch(() => undefined);
      }
    };

    it('30 wrong passwords per address in 10 minutes, then 429 without checking the password', async () => {
      await spray(30);
      hasher.compare.mockClear();
      const err = await guarded.execute('person99@x.test', 'Winter2026!', office).catch((e) => e);
      expect(err).toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
      expect(err.message).toMatch(/failed sign-ins from your network/);
      expect(hasher.compare).not.toHaveBeenCalled();
      // Even the right password, for an account never signed in from here.
      hasher.compare.mockResolvedValue(true);
      await expect(
        guarded.execute('admin@timechamp.test', 'admin123', office),
      ).rejects.toMatchObject({
        status: 429,
      });
    });

    it('people who signed in from that address before still sign in; their mistakes answer 429', async () => {
      await spray(30);
      refreshTokens.signedInFrom.mockResolvedValue(true);
      hasher.compare.mockResolvedValue(true);
      const ok = await guarded.execute('admin@timechamp.test', 'admin123', office);
      expect(ok.accessToken).toBe('access');
      expect(refreshTokens.signedInFrom).toHaveBeenCalledWith('u-1', office.ip, expect.any(Date));
      hasher.compare.mockResolvedValue(false);
      await expect(guarded.execute('admin@timechamp.test', 'typo', office)).rejects.toMatchObject({
        status: 429,
        code: 'TOO_MANY_ATTEMPTS',
      });
      refreshTokens.signedInFrom.mockResolvedValue(false);
    });

    it('below the limit a wrong password is a plain 401; another address is not affected', async () => {
      await spray(29);
      await expect(guarded.execute('admin@timechamp.test', 'typo', office)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      await expect(
        guarded.execute('admin@timechamp.test', 'typo', { ...office, ip: '198.51.100.9' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });
});
