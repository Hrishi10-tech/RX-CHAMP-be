import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { InMemoryEventBus } from '@shared/events/in-memory-event-bus';
import {
  ALL_ORGS_ROOM,
  deptRoom,
  deptStaffRoom,
  membersRoom,
  orgRoom,
  PLATFORM_ROOM,
  userRoom,
} from '@shared/websocket/socket-rooms';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { AvatarChangedSubscriber } from './avatar-changed.subscriber';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function wired(audience: (userId: string) => Promise<string[]>) {
  const gateway = Object.create(NotificationsGateway.prototype) as NotificationsGateway;
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  Object.defineProperty(gateway, 'server', { value: { to }, writable: true });
  Object.defineProperty(gateway, 'access', {
    value: { avatarAudience: jest.fn(audience) },
    writable: true,
  });
  const bus = new InMemoryEventBus();
  new AvatarChangedSubscriber(bus, gateway).onModuleInit();
  return { bus, to, emit };
}

describe('avatar:changed', () => {
  it('goes once to the rooms read for the person at send time', async () => {
    const rooms = [userRoom('u-1'), orgRoom('co-1'), ALL_ORGS_ROOM, deptRoom('d-1')];
    const { bus, to, emit } = wired(() => Promise.resolve(rooms));
    await bus.publish(AvatarChangedEvent.eventName, new AvatarChangedEvent('u-1', 'M12', 'co-1'));
    await flush();

    expect(to).toHaveBeenCalledWith(rooms);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('avatar:changed', { userId: 'u-1', avatarId: 'M12' });
  });

  it('says null while the person has no gender', async () => {
    const { bus, emit } = wired(() => Promise.resolve([userRoom('u-1')]));
    await bus.publish(AvatarChangedEvent.eventName, new AvatarChangedEvent('u-1', null, 'co-1'));
    await flush();
    expect(emit).toHaveBeenCalledWith('avatar:changed', { userId: 'u-1', avatarId: null });
  });

  it('the room names stay apart from the other live rooms', () => {
    expect(orgRoom('co-1')).toBe('org:co-1');
    expect(ALL_ORGS_ROOM).toBe('org:*');
    expect(PLATFORM_ROOM).toBe('platform');
    expect(deptStaffRoom('d-1')).toBe('dept-staff:d-1');
    expect(deptStaffRoom('d-1')).not.toBe(deptRoom('d-1'));
    expect(membersRoom('co-1')).toBe('members:co-1');
  });
});
