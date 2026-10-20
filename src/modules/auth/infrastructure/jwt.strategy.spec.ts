import { UnauthorizedError } from '@shared/exceptions/app.exception';
import { SOCKET_TOKEN_TYPE } from '@shared/security/token.service.port';
import { JwtStrategy } from './jwt.strategy';

/** A request with only the headers validate() reads. */
function req(headers: Record<string, string | string[]> = {}) {
  return { headers } as never;
}

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
      strategy.validate(req(), { sub: 'u-1', email: 'u@test', role: 'MANAGER', typ: SOCKET_TOKEN_TYPE }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // Refused before the user is even loaded.
    expect(reader.loadById).not.toHaveBeenCalled();
  });

  it('rejects an enrollment token, or any other typed token', async () => {
    for (const typ of ['enroll', 'anything']) {
      await expect(
        strategy.validate(req(), { sub: 'u-1', email: 'u@test', role: 'MANAGER', typ } as never),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(reader.loadById).not.toHaveBeenCalled();
  });

  it('accepts a normal access token', async () => {
    const user = await strategy.validate(req(), { sub: 'u-1', email: 'u@test', role: 'MANAGER' });
    expect(user).toBe(activeUser);
    expect(reader.loadById).toHaveBeenCalledWith('u-1', undefined);
  });

  it('still rejects a disabled account', async () => {
    reader.loadById.mockResolvedValue({ ...activeUser, status: 'DISABLED' });

    await expect(
      strategy.validate(req(), { sub: 'u-1', email: 'u@test', role: 'MANAGER' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a deleted or unknown account', async () => {
    reader.loadById.mockResolvedValue(null);
    await expect(
      strategy.validate(req(), { sub: 'u-gone', email: 'g@test', role: 'USER' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('JwtStrategy — X-Org-Id (4.0 organisation switcher)', () => {
  const superAdmin = { id: 'sa-1', email: 'sa@test', role: 'SUPER_ADMIN', status: 'ACTIVE', orgId: 'org-a' };
  const reader = { loadById: jest.fn() } as any;
  const config = { get: jest.fn().mockReturnValue('secret') } as any;
  let strategy: JwtStrategy;

  beforeEach(() => {
    jest.clearAllMocks();
    reader.loadById.mockResolvedValue(superAdmin);
    strategy = new JwtStrategy(config, reader);
  });

  it("passes the header to the reader, which resolves the Super Admin's organisation", async () => {
    const user = await strategy.validate(req({ 'x-org-id': 'org-a' }), { sub: 'sa-1', email: 'sa@test', role: 'SUPER_ADMIN' });
    expect(reader.loadById).toHaveBeenCalledWith('sa-1', 'org-a');
    expect(user).toBe(superAdmin);
  });

  it('a repeated header uses the first value', async () => {
    await strategy.validate(req({ 'x-org-id': ['org-a', 'org-b'] }), { sub: 'sa-1', email: 'sa@test', role: 'SUPER_ADMIN' });
    expect(reader.loadById).toHaveBeenCalledWith('sa-1', 'org-a');
  });

  it('no header: the reader gets none (platform view for a Super Admin, own organisation for everyone else)', async () => {
    await strategy.validate(req(), { sub: 'sa-1', email: 'sa@test', role: 'SUPER_ADMIN' });
    expect(reader.loadById).toHaveBeenCalledWith('sa-1', undefined);
  });

  it('a request without headers (socket-less edge) still validates', async () => {
    await strategy.validate(undefined as never, { sub: 'sa-1', email: 'sa@test', role: 'SUPER_ADMIN' });
    expect(reader.loadById).toHaveBeenCalledWith('sa-1', undefined);
  });
});
