import { SOCKET_TICKET_TTL_SEC } from '@shared/security/token.service.port';
import { AuthController } from './auth.controller';

/**
 * F-12: a socket ticket is minted under the epoch of the session that asked for
 * it (the one JwtStrategy just checked), so a ticket fetched before a sign-out
 * opens nothing after it.
 */
describe('AuthController: GET /auth/socket-ticket', () => {
  it("mints the ticket under the caller's current auth epoch", async () => {
    const tokens = { signSocketTicket: jest.fn().mockResolvedValue('ticket') };
    const controller = new AuthController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tokens as never,
    );
    const me = { id: 'u-1', email: 'u@rx.test', role: 'MANAGER', authEpoch: 5 } as never;

    await expect(controller.socketTicket(me)).resolves.toEqual({
      token: 'ticket',
      expiresIn: SOCKET_TICKET_TTL_SEC,
    });
    expect(tokens.signSocketTicket).toHaveBeenCalledWith({
      sub: 'u-1',
      email: 'u@rx.test',
      role: 'MANAGER',
      ep: 5,
    });
  });
});
