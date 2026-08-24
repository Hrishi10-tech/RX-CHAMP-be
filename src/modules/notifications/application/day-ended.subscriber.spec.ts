import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { DayEndedSubscriber } from './day-ended.subscriber';

/**
 * The sign-off time has to be printed in the business timezone. Left to the host
 * clock it used UTC, and managers were told 6:38 PM sign-offs happened at 1:08 PM.
 */
describe('DayEndedSubscriber', () => {
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const notifications = { create: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn() } as any;

  // 2026-08-21 13:08 UTC === 6:38 PM in Asia/Kolkata.
  const endedAt = new Date('2026-08-21T13:08:59.000Z');

  function subscriberWith(timezone?: string) {
    const config = { get: jest.fn().mockReturnValue(timezone) } as any;
    const s = new DayEndedSubscriber(events, notifications, gateway, config);
    s.onModuleInit();
    return events.subscribe.mock.calls.at(-1)[1] as (e: DayEndedEvent) => Promise<void>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.create.mockImplementation((d: any) =>
      Promise.resolve({ id: 'n-1', readAt: null, createdAt: endedAt, fromUserId: null, ...d }),
    );
  });

  it('prints the sign-off time in the configured timezone', async () => {
    const handle = subscriberWith('Asia/Kolkata');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', 'mgr-1', '2026-08-21', endedAt));

    const { body, userId } = notifications.create.mock.calls[0][0];
    expect(userId).toBe('mgr-1');
    expect(body).toContain('6:38 PM');
    // The UTC reading is what the bug produced.
    expect(body).not.toContain('1:08 PM');
  });

  it('falls back to the business timezone when none is configured', async () => {
    const handle = subscriberWith(undefined);
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', 'mgr-1', '2026-08-21', endedAt));

    expect(notifications.create.mock.calls[0][0].body).toContain('6:38 PM');
  });

  it('honours a different timezone', async () => {
    const handle = subscriberWith('UTC');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', 'mgr-1', '2026-08-21', endedAt));

    expect(notifications.create.mock.calls[0][0].body).toContain('1:08 PM');
  });

  it('says nothing when the user has no manager', async () => {
    const handle = subscriberWith('Asia/Kolkata');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', null, '2026-08-21', endedAt));

    expect(notifications.create).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
