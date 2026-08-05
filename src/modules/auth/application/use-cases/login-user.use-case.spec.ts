
import { Role } from '@shared/rbac/roles.enum';
import { AccountDisabledError, InvalidCredentialsError } from '@shared/exceptions/app.exception';
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
    createdAt: new Date(),
  });
}

describe('LoginUserUseCase', () => {
  const users = { findByEmail: jest.fn() } as any;
  const hasher = { compare: jest.fn(), hash: jest.fn() } as any;
  const tokens = { signAccessToken: jest.fn() } as any;
  const refreshTokens = { issue: jest.fn(), rotate: jest.fn(), revoke: jest.fn() } as any;
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
});
