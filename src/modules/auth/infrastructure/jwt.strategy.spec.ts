import { UnauthorizedError } from '@shared/exceptions/app.exception';
import { SOCKET_TOKEN_TYPE } from '@shared/security/token.service.port';
import { JwtStrategy } from './jwt.strategy';

/**
 * The security boundary for socket tickets. They are signed with the access secret
 * and — unlike the httpOnly cookie — are readable by JavaScript, so the HTTP path
 * must refuse them. Otherwise anything that scraped a ticket would hold a working
 * API credential for its lifetime.
 */
describe('JwtStrategy — socket tickets are not API credentials', () => {
  const activeUser = { id: 'u-1', email: 'u@test', role: 'MANAGER', status: 'ACTIVE' };
  const reader = { loadById: jest.fn() } as any;
  const config = { get: jest.fn().mockReturnValue('secret') } as any;

  let strategy: JwtStrategy;
  beforeEach(() => {
    jest.clearAllMocks();
    reader.loadById.mockResolvedValue(activeUser);
    strategy = new JwtStrategy(config, reader);
  });

  it('rejects a socket ticket', async () => {
    await expect(
      strategy.validate({ sub: 'u-1', email: 'u@test', role: 'MANAGER', typ: SOCKET_TOKEN_TYPE }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Refused before the user is even loaded.
    expect(reader.loadById).not.toHaveBeenCalled();
  });

  it('accepts a normal access token', async () => {
    const user = await strategy.validate({ sub: 'u-1', email: 'u@test', role: 'MANAGER' });
    expect(user).toBe(activeUser);
  });

  it('still rejects a disabled account', async () => {
    reader.loadById.mockResolvedValue({ ...activeUser, status: 'DISABLED' });

    await expect(
      strategy.validate({ sub: 'u-1', email: 'u@test', role: 'MANAGER' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
