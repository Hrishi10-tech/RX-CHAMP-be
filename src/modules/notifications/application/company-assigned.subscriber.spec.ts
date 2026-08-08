// Unit test for CompanyAssignedSubscriber — verifies it persists + pushes a
// notification for MANAGER assignments and ignores non-manager roles.
import { Role } from '@shared/rbac/roles.enum';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { CompanyAssignedSubscriber } from './company-assigned.subscriber';

describe('CompanyAssignedSubscriber', () => {
  const notifications = {
    create: jest.fn(),
    listForUser: jest.fn(),
    countForUser: jest.fn(),
  } as any;
  const gateway = { emitToUser: jest.fn() } as any;
  let captured: (e: CompanyAssignedEvent) => Promise<void>;
  const events = {
    publish: jest.fn(),
    subscribe: jest.fn((_name: string, handler: any) => {
      captured = handler;
    }),
  } as any;

  let subscriber: CompanyAssignedSubscriber;
  beforeEach(() => {
    jest.clearAllMocks();
    subscriber = new CompanyAssignedSubscriber(events, notifications, gateway);
    subscriber.onModuleInit();
  });

  function event(role: Role): CompanyAssignedEvent {
    return new CompanyAssignedEvent('mgr-1', role, 'c-1', 'Acme', 'super-1', new Date());
  }

  it('subscribes on init', () => {
    expect(events.subscribe).toHaveBeenCalledWith(
      CompanyAssignedEvent.eventName,
      expect.any(Function),
    );
  });

  it('persists and pushes a notification for a MANAGER', async () => {
    const saved = {
      id: 'n-1',
      userId: 'mgr-1',
      type: 'COMPANY_ASSIGNED',
      title: 'New company assigned',
      body: 'You have been assigned to Acme.',
      readAt: null,
      createdAt: new Date(),
    };
    notifications.create.mockResolvedValue(saved);

    await captured(event(Role.MANAGER));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mgr-1', type: 'COMPANY_ASSIGNED' }),
    );
    expect(gateway.emitToUser).toHaveBeenCalledWith(
      'mgr-1',
      expect.objectContaining({ id: 'n-1', read: false }),
    );
  });

  it('ignores non-manager roles', async () => {
    await captured(event(Role.USER));
    expect(notifications.create).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
