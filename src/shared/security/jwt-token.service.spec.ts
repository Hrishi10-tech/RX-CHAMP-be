import { JwtService } from '@nestjs/jwt';
import { JwtTokenService } from './jwt-token.service';
import { SOCKET_TICKET_TTL_SEC, SOCKET_TOKEN_TYPE } from './token.service.port';

/**
 * A socket ticket is signed with the access secret so the gateways can verify it
 * without a second key — which means the only thing keeping it out of the HTTP path
 * is its `typ` claim. These tests pin that claim and its lifetime.
 */
describe('JwtTokenService.signSocketTicket', () => {
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed') } as unknown as JwtService;
  const config = { get: jest.fn() } as any;
  const service = new JwtTokenService(jwt, config);

  const payload = { sub: 'u-1', email: 'u@test', role: 'MANAGER', ep: 2 };

  beforeEach(() => jest.clearAllMocks());

  it('marks the ticket as socket-only', async () => {
    await service.signSocketTicket(payload);

    const [claims] = (jwt.signAsync as jest.Mock).mock.calls[0];
    expect(claims).toMatchObject({ ...payload, typ: SOCKET_TOKEN_TYPE });
  });

  it('is short-lived', async () => {
    await service.signSocketTicket(payload);

    const [, options] = (jwt.signAsync as jest.Mock).mock.calls[0];
    expect(options.expiresIn).toBe(`${SOCKET_TICKET_TTL_SEC}s`);
    expect(SOCKET_TICKET_TTL_SEC).toBeLessThanOrEqual(600);
  });

  it('leaves a normal access token untyped, so it still works over HTTP', async () => {
    await service.signAccessToken(payload);

    const [claims] = (jwt.signAsync as jest.Mock).mock.calls[0];
    expect(claims).not.toHaveProperty('typ');
  });
});

/**
 * F-02, F-03: an enrollment token says under which auth epoch and by whom it was
 * minted, so the exchange can refuse it once either no longer stands. Signed and
 * verified for real here: the claims have to survive the round trip.
 */
describe('JwtTokenService: enrollment tokens', () => {
  const jwt = new JwtService({});
  const config = {
    get: (key: string) => (key === 'jwt.enrollSecret' ? 'enroll-secret' : undefined),
  } as any;
  const service = new JwtTokenService(jwt, config);

  it('carries the subject, its enrollVersion (4.0), its epoch and the minter', async () => {
    const token = await service.signEnrollmentToken('u-1', {
      enrollVersion: 3,
      epoch: 4,
      mintedBy: 'm-1',
    });

    expect(jwt.decode(token)).toMatchObject({ sub: 'u-1', typ: 'enroll', ev: 3, ep: 4, mb: 'm-1' });
    await expect(service.verifyEnrollmentToken(token)).resolves.toEqual({
      userId: 'u-1',
      enrollVersion: 3,
      epoch: 4,
      mintedBy: 'm-1',
    });
  });

  it('reads a token from before the claims existed as epoch 0 with no minter', async () => {
    const old = await jwt.signAsync({ sub: 'u-1', typ: 'enroll' }, { secret: 'enroll-secret' });

    await expect(service.verifyEnrollmentToken(old)).resolves.toEqual({
      userId: 'u-1',
      enrollVersion: 1,
      epoch: 0,
      mintedBy: null,
    });
  });

  it('refuses a token signed with another algorithm, even with the right secret', async () => {
    const other = await jwt.signAsync(
      { sub: 'u-1', typ: 'enroll', ep: 0 },
      { secret: 'enroll-secret', algorithm: 'HS512' },
    );

    await expect(service.verifyEnrollmentToken(other)).rejects.toThrow(
      'Invalid or expired enrollment token.',
    );
  });

  it('still refuses a token of another type or another secret', async () => {
    const access = await jwt.signAsync({ sub: 'u-1' }, { secret: 'enroll-secret' });
    const foreign = await jwt.signAsync({ sub: 'u-1', typ: 'enroll' }, { secret: 'not-ours' });

    await expect(service.verifyEnrollmentToken(access)).rejects.toThrow('Not an enrollment token.');
    await expect(service.verifyEnrollmentToken(foreign)).rejects.toThrow(
      'Invalid or expired enrollment token.',
    );
  });
});
