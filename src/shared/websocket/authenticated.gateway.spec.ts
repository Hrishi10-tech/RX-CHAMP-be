import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@shared/rbac/roles.enum';
import { ChatGateway } from '@modules/chat/presentation/chat.gateway';
import { SocketAccessService } from './socket-access.service';

const SECRET = 'access-secret';
const jwt = new JwtService({});
const config = {
  get: (key: string) => (key === 'jwt.accessSecret' ? SECRET : undefined),
} as unknown as ConfigService;

/** What a handshake hands the gateway: the token in `auth.token`, as every client sends it. */
class FakeSocket extends EventEmitter {
  id = 'sock-1';
  data: Record<string, unknown> = {};
  disconnected = false;
  rooms: string[] = [];
  handshake: { headers: Record<string, string>; auth: { token?: string } };
  sent: Array<[string, unknown]> = [];

  constructor(token?: string) {
    super();
    this.handshake = { headers: {}, auth: { token } };
  }

  join = jest.fn(async (room: string | string[]) => {
    this.rooms.push(...(Array.isArray(room) ? room : [room]));
  });
  disconnect = jest.fn(() => {
    this.disconnected = true;
  });
  // The client-bound events, kept apart from the EventEmitter the server listens on.
  emit = ((name: string, payload?: unknown) => {
    this.sent.push([name, payload]);
    return true;
  }) as never;
}

/** The users table as the admission reads it: one account, with this epoch and role. */
function access(row: { authEpoch: number; role: Role; status?: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(
    row && {
      status: row.status ?? 'ACTIVE',
      authEpoch: row.authEpoch,
      role: { name: row.role },
    },
  );
  const service = new SocketAccessService(
    { user: { findFirst } } as never,
    { subscribe: jest.fn() } as never,
    { get: (key: string) => (key === 'jwt.accessTtl' ? '15m' : []) } as unknown as ConfigService,
  );
  jest.spyOn(service, 'watch').mockImplementation(() => undefined);
  return service;
}

const accessToken = (ep?: number) =>
  jwt.sign({ sub: 'u-1', email: 'u@rx.test', role: 'MANAGER', ep }, { secret: SECRET });
const ticket = (ep?: number) =>
  jwt.sign(
    { sub: 'u-1', email: 'u@rx.test', role: 'MANAGER', ep, typ: 'socket' },
    { secret: SECRET },
  );

describe('socket handshakes and the auth epoch (F-12)', () => {
  it.each([
    ['an access token', accessToken(4)],
    ['a socket ticket', ticket(4)],
  ])('admits %s minted under the current epoch, and has it watched', async (_name, token) => {
    const service = access({ authEpoch: 4, role: Role.MANAGER });
    const socket = new FakeSocket(token);

    await new ChatGateway(jwt, config, service).handleConnection(socket as never);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.rooms).toEqual(['account:u-1', 'user:u-1']);
    expect(service.watch).toHaveBeenCalledWith(socket, 'u-1', 4);
  });

  it.each([
    ['an access token', accessToken(3)],
    ['a socket ticket', ticket(3)],
    ['a token with no epoch claim, once the epoch has been raised', accessToken()],
  ])('refuses %s from before the sign-out', async (_name, token) => {
    const service = access({ authEpoch: 4, role: Role.MANAGER });
    const socket = new FakeSocket(token);

    await new ChatGateway(jwt, config, service).handleConnection(socket as never);

    expect(socket.sent).toEqual([['unauthorized', { message: 'Not signed in' }]]);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.rooms).toEqual([]);
    expect(service.watch).not.toHaveBeenCalled();
  });

  it('a token with no epoch claim still opens a socket while the account is at 0', async () => {
    const service = access({ authEpoch: 0, role: Role.USER });
    const socket = new FakeSocket(accessToken());

    await new ChatGateway(jwt, config, service).handleConnection(socket as never);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(service.watch).toHaveBeenCalledWith(socket, 'u-1', 0);
  });

  it('still refuses a bad signature, another typed token and an account that is off', async () => {
    const cases: Array<[string, SocketAccessService]> = [
      [
        jwt.sign({ sub: 'u-1', ep: 4 }, { secret: 'not-ours' }),
        access({ authEpoch: 4, role: Role.USER }),
      ],
      [
        jwt.sign({ sub: 'u-1', ep: 4, typ: 'enroll' }, { secret: SECRET }),
        access({ authEpoch: 4, role: Role.USER }),
      ],
      [accessToken(4), access({ authEpoch: 4, role: Role.USER, status: 'DISABLED' })],
      [accessToken(4), access(null)],
    ];
    for (const [token, service] of cases) {
      const socket = new FakeSocket(token);
      await new ChatGateway(jwt, config, service).handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.rooms).toEqual([]);
    }
  });
});
