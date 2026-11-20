import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { UserAccessChange, UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { Role } from '@shared/rbac/roles.enum';
import { SocketAccessService } from './socket-access.service';

/**
 * 4.0 live rooms per grant (docs/4.0/SPEC.md 1.2, 1.4): what a portal socket joins
 * in each namespace. A Manager with no grant joins nothing; activity is split into
 * the timeline part and the activity part.
 */
function setup(row: Record<string, unknown> | null) {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(row) },
    company: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
  };
  const events = { subscribe: jest.fn(), publish: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'jwt.accessTtl' ? '15m' : ['*'])) };
  return new SocketAccessService(prisma as never, events as never, config as never);
}

const manager = (grants: { screenshots?: boolean; timeline?: boolean; activity?: boolean }) => ({
  companyId: 'c1',
  grantScreenshots: grants.screenshots ?? false,
  grantTimeline: grants.timeline ?? false,
  grantActivity: grants.activity ?? false,
  role: { name: 'MANAGER' },
  managedDepartments: [{ departmentId: 'd1' }, { departmentId: 'd2' }],
});

describe('SocketAccessService.roomsFor (4.0 grants)', () => {
  it('a Manager with no grant joins no team room in any namespace', async () => {
    const svc = setup(manager({}));
    for (const section of ['presence', 'activity', 'screenshots'] as const) {
      expect(await svc.roomsFor('m1', null, section)).toEqual([]);
    }
  });

  it('presence: any one grant opens the department rooms', async () => {
    for (const g of [{ screenshots: true }, { timeline: true }, { activity: true }]) {
      expect(await setup(manager(g)).roomsFor('m1', null, 'presence')).toEqual([
        'dept:d1',
        'dept:d2',
      ]);
    }
  });

  it('activity: both grants the whole push; one grant its redacted room', async () => {
    expect(
      await setup(manager({ timeline: true, activity: true })).roomsFor('m1', null, 'activity'),
    ).toEqual(['dept:d1', 'dept:d2']);
    expect(await setup(manager({ timeline: true })).roomsFor('m1', null, 'activity')).toEqual([
      'dept:d1|timeline',
      'dept:d2|timeline',
    ]);
    expect(await setup(manager({ activity: true })).roomsFor('m1', null, 'activity')).toEqual([
      'dept:d1|activity',
      'dept:d2|activity',
    ]);
    expect(await setup(manager({ screenshots: true })).roomsFor('m1', null, 'activity')).toEqual(
      [],
    );
  });

  it('screenshots: only with that grant', async () => {
    expect(
      await setup(manager({ timeline: true, activity: true })).roomsFor('m1', null, 'screenshots'),
    ).toEqual([]);
    expect(await setup(manager({ screenshots: true })).roomsFor('m1', null, 'screenshots')).toEqual(
      ['dept:d1', 'dept:d2'],
    );
  });

  it('an Admin gets the organisation room everywhere; Staff nothing', async () => {
    const admin = setup({ companyId: 'c1', role: { name: 'ADMIN' }, managedDepartments: [] });
    for (const section of ['presence', 'activity', 'screenshots'] as const) {
      expect(await admin.roomsFor('a1', null, section)).toEqual(['org:c1']);
    }
    const staff = setup({ companyId: 'c1', role: { name: 'USER' }, managedDepartments: [] });
    expect(await staff.roomsFor('u1', null, 'presence')).toEqual([]);
  });
});

/* 3.6 (F-12): admission by auth epoch, the periodic re-check, and eviction. */
/** An access-token lifetime of one minute, so the re-check is easy to step through. */
const epochConfig = {
  get: (key: string) => (key === 'jwt.accessTtl' ? '1m' : []),
} as unknown as ConfigService;

function service(user: { findFirst?: jest.Mock; findMany?: jest.Mock }) {
  return new SocketAccessService({ user } as never, { subscribe: jest.fn() } as never, epochConfig);
}

const down = () => Promise.reject(new Error('Timed out fetching a new connection from the pool'));

describe('SocketAccessService (3.6 auth epoch)', () => {
  /** The account row as the admission reads it. */
  const account = (over: { status?: string; authEpoch?: number; role?: Role } = {}) => ({
    status: over.status ?? 'ACTIVE',
    authEpoch: over.authEpoch ?? 2,
    role: { name: over.role ?? Role.MANAGER },
  });

  // F-12: a token or ticket from before a sign-out is refused at the handshake.
  describe('admission', () => {
    it('admits an active account whose credential carries its current epoch', async () => {
      const findFirst = jest.fn().mockResolvedValue(account());
      await expect(service({ findFirst }).admit('u-1', 2)).resolves.toEqual({
        role: Role.MANAGER,
      });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1', deletedAt: null } }),
      );
    });

    it.each([
      ['minted before the epoch moved', account({ authEpoch: 3 })],
      ['for an account that is off', account({ status: 'DISABLED' })],
      ['for an account that is gone', null],
    ])('refuses a credential %s', async (_name, row) => {
      const findFirst = jest.fn().mockResolvedValue(row);
      await expect(service({ findFirst }).admit('u-1', 2)).resolves.toBeNull();
    });

    it('refuses when the account cannot be read', async () => {
      await expect(service({ findFirst: jest.fn(down) }).admit('u-1', 2)).resolves.toBeNull();
    });
  });

  // F-12: an open socket does not outlive the access-token lifetime unquestioned.
  describe('an open socket is asked about again every access-token lifetime', () => {
    class FakeSocket extends EventEmitter {
      disconnected = false;
      disconnect = jest.fn(() => {
        this.disconnected = true;
        this.emit('disconnect', 'server namespace disconnect');
      });
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function watched(findFirst: jest.Mock) {
      const socket = new FakeSocket();
      service({ findFirst }).watch(socket as never, 'u-1', 2);
      return socket;
    }

    it('leaves it open while the account stands, and keeps asking', async () => {
      const findFirst = jest.fn().mockResolvedValue(account());
      const socket = watched(findFirst);

      await jest.advanceTimersByTimeAsync(59_000);
      expect(findFirst).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(findFirst).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(120_000);
      expect(findFirst).toHaveBeenCalledTimes(3);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it.each([
      ['the epoch has moved (signed out)', account({ authEpoch: 3 })],
      ['the account is off', account({ status: 'DISABLED' })],
      ['the account is gone', null],
    ])('ends it at the next check once %s', async (_name, row) => {
      const findFirst = jest.fn().mockResolvedValue(account());
      const socket = watched(findFirst);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(socket.disconnect).not.toHaveBeenCalled();

      findFirst.mockResolvedValue(row);
      await jest.advanceTimersByTimeAsync(60_000);

      // Ended the way an evicted socket is, and never asked about again.
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      await jest.advanceTimersByTimeAsync(300_000);
      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a failed read ends nothing: it asks again at the next check', async () => {
      const findFirst = jest.fn(down);
      const socket = watched(findFirst);

      await jest.advanceTimersByTimeAsync(120_000);

      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('stops asking once the socket has closed', async () => {
      const findFirst = jest.fn().mockResolvedValue(account());
      const socket = watched(findFirst);

      socket.disconnected = true;
      socket.emit('disconnect', 'transport close');
      await jest.advanceTimersByTimeAsync(300_000);

      expect(findFirst).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  // F-12: sockets drop with every change that ends the account's credentials.
  describe('eviction', () => {
    function listening() {
      const handlers = new Map<string, (e: unknown) => void>();
      const events = {
        subscribe: jest.fn((name: string, handler: (e: unknown) => void) => {
          handlers.set(name, handler);
        }),
      };
      const access = new SocketAccessService({ user: {} } as never, events as never, epochConfig);
      const disconnectSockets = jest.fn();
      const room = jest.fn().mockReturnValue({ disconnectSockets });
      access.track({ in: room } as never);
      access.onModuleInit();
      const changed = (changes: UserAccessChange[], active?: boolean) =>
        handlers.get(UserAccessChangedEvent.eventName)!(
          new UserAccessChangedEvent('u-1', changes, new Date(), active),
        );
      return { handlers, room, disconnectSockets, changed };
    }

    it("drops the account's sockets when the owner signs their other devices out", () => {
      const { handlers, room, disconnectSockets } = listening();

      handlers.get(OtherDevicesSignedOutEvent.eventName)!(new OtherDevicesSignedOutEvent('u-1'));

      expect(room).toHaveBeenCalledWith('account:u-1');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });

    it.each<[string, UserAccessChange[], boolean | undefined]>([
      ['sign out everywhere', ['SIGN_OUT'], true],
      ['a delete', ['DELETED'], false],
      ['a block', ['STATUS'], false],
      ['a role change', ['ROLE'], undefined],
      ['a manager change', ['MANAGER'], undefined],
    ])('drops them on %s', (_name, changes, active) => {
      const { room, disconnectSockets, changed } = listening();

      changed(changes, active);

      expect(room).toHaveBeenCalledWith('account:u-1');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });

    it('leaves them alone when an administrator only set a password', () => {
      const { disconnectSockets, changed } = listening();

      changed(['PASSWORD'], true);

      expect(disconnectSockets).not.toHaveBeenCalled();
    });
  });
});
