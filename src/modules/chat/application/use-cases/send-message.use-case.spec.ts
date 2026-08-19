import { ChatMessageSentEvent } from '../../domain/events/chat-message-sent.event';
import { SendMessageUseCase } from './send-message.use-case';

describe('SendMessageUseCase', () => {
  const repo = { create: jest.fn() } as any;
  const contacts = { findContacts: jest.fn(), findSender: jest.fn() } as any;
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn() } as any;

  const createdAt = new Date('2026-08-19T10:15:00.000Z');
  let useCase: SendMessageUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    repo.create.mockResolvedValue({
      id: 'm-1',
      fromUserId: 'from-1',
      toUserId: 'to-1',
      body: 'hello',
      readAt: null,
      createdAt,
    });
    contacts.findSender.mockResolvedValue({ id: 'from-1', firstName: 'Ravi', lastName: 'Kumar' });
    useCase = new SendMessageUseCase(repo, contacts, events, gateway);
  });

  it('delivers over the chat socket to both sides and raises the notification event', async () => {
    const view = await useCase.execute('from-1', { toUserId: 'to-1', body: 'hello' });

    expect(view).toMatchObject({ id: 'm-1', mine: true });
    expect(gateway.emitToUser).toHaveBeenCalledTimes(2);

    expect(events.publish).toHaveBeenCalledWith(
      'chat.message-sent',
      expect.objectContaining({
        toUserId: 'to-1',
        fromUserId: 'from-1',
        fromName: 'Ravi Kumar',
        messageId: 'm-1',
        body: 'hello',
      }),
    );
    expect(events.publish.mock.calls[0][1]).toBeInstanceOf(ChatMessageSentEvent);
  });

  it('still sends when the sender cannot be named', async () => {
    contacts.findSender.mockResolvedValue(undefined);

    await useCase.execute('from-1', { toUserId: 'to-1', body: 'hello' });

    expect(events.publish.mock.calls[0][1]).toMatchObject({ fromName: 'Someone' });
  });

  it('never fails the send because notifying failed', async () => {
    events.publish.mockRejectedValue(new Error('bus down'));

    await expect(
      useCase.execute('from-1', { toUserId: 'to-1', body: 'hello' }),
    ).resolves.toMatchObject({ id: 'm-1' });

    // The message itself was still delivered to both participants.
    expect(gateway.emitToUser).toHaveBeenCalledTimes(2);
  });
});
