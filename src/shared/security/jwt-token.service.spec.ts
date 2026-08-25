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

  const payload = { sub: 'u-1', email: 'u@test', role: 'MANAGER' };

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
