import { ChatMessageSentEvent } from '@modules/chat/domain/events/chat-message-sent.event';
import { ChatMessageSubscriber } from './chat-message.subscriber';

describe('ChatMessageSubscriber', () => {
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const notifications = { create: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn() } as any;

  const sentAt = new Date('2026-08-19T10:15:00.000Z');

  /** Runs the subscriber's handler for one event, as the bus would. */
  async function deliver(event: ChatMessageSentEvent) {
    const subscriber = new ChatMessageSubscriber(events, notifications, gateway);
    subscriber.onModuleInit();
    const handler = events.subscribe.mock.calls[0][1];
    await handler(event);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.create.mockImplementation((data: any) =>
      Promise.resolve({ id: 'n-1', readAt: null, createdAt: sentAt, body: null, ...data }),
    );
  });

  it('subscribes to the chat event by name', () => {
    const subscriber = new ChatMessageSubscriber(events, notifications, gateway);
    subscriber.onModuleInit();
    expect(events.subscribe).toHaveBeenCalledWith('chat.message-sent', expect.any(Function));
  });

  it('notifies the recipient, naming the sender and carrying fromUserId', async () => {
    await deliver(new ChatMessageSentEvent('to-1', 'from-1', 'Ravi Kumar', 'm-1', 'hello', sentAt));

    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'to-1',
      type: 'CHAT_MESSAGE',
      title: 'New message from Ravi Kumar',
      body: 'hello',
      fromUserId: 'from-1',
    });

    // The realtime push goes to the recipient, not the sender.
    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    const [userId, view] = gateway.emitToUser.mock.calls[0];
    expect(userId).toBe('to-1');
    expect(view).toMatchObject({
      id: 'n-1',
      type: 'CHAT_MESSAGE',
      fromUserId: 'from-1',
      read: false,
      readAt: null,
      createdAt: sentAt.toISOString(),
    });
  });

  it('truncates a long body so a toast stays a preview', async () => {
    const long = 'x'.repeat(400);
    await deliver(new ChatMessageSentEvent('to-1', 'from-1', 'Ravi', 'm-2', long, sentAt));

    const { body } = notifications.create.mock.calls[0][0];
    expect(body).toHaveLength(140);
    expect(body.endsWith('…')).toBe(true);
  });

  it('leaves a body at the limit untouched', async () => {
    const exact = 'y'.repeat(140);
    await deliver(new ChatMessageSentEvent('to-1', 'from-1', 'Ravi', 'm-3', exact, sentAt));

    expect(notifications.create.mock.calls[0][0].body).toBe(exact);
  });
});
