import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { DayEndedSubscriber } from './day-ended.subscriber';
import { OversightRecipients } from './oversight-recipients.service';

/**
 * The sign-off time has to be printed in the business timezone. Left to the host
 * clock it used UTC, and managers were told 6:38 PM sign-offs happened at 1:08 PM.
 * 4.0: the recipients are the department's managers (or the Admin), not manager_id.
 */
describe('DayEndedSubscriber', () => {
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const notifications = { create: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn() } as any;
  const recipients = { of: jest.fn() };

  // 2026-08-21 13:08 UTC === 6:38 PM in Asia/Kolkata.
  const endedAt = new Date('2026-08-21T13:08:59.000Z');

  function subscriberWith(timezone?: string) {
    const config = { get: jest.fn().mockReturnValue(timezone) } as any;
    const s = new DayEndedSubscriber(events, notifications, gateway, config, recipients as any);
    s.onModuleInit();
    return events.subscribe.mock.calls.at(-1)[1] as (e: DayEndedEvent) => Promise<void>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    recipients.of.mockResolvedValue(['mgr-1']);
    notifications.create.mockImplementation((d: any) =>
      Promise.resolve({ id: 'n-1', readAt: null, createdAt: endedAt, fromUserId: null, ...d }),
    );
  });

  it('prints the sign-off time in the configured timezone', async () => {
    const handle = subscriberWith('Asia/Kolkata');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', null, '2026-08-21', endedAt));

    const { body, userId } = notifications.create.mock.calls[0][0];
    expect(userId).toBe('mgr-1');
    expect(body).toContain('6:38 PM');
    expect(body).not.toContain('1:08 PM');
  });

  it('falls back to the business timezone when none is configured', async () => {
    const handle = subscriberWith(undefined);
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', null, '2026-08-21', endedAt));
    expect(notifications.create.mock.calls[0][0].body).toContain('6:38 PM');
  });

  it('honours a different timezone', async () => {
    const handle = subscriberWith('UTC');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', null, '2026-08-21', endedAt));
    expect(notifications.create.mock.calls[0][0].body).toContain('1:08 PM');
  });

  it("tells every one of the department's managers, ignoring the 3.x manager_id", async () => {
    recipients.of.mockResolvedValue(['mgr-1', 'mgr-2']);
    const handle = subscriberWith('Asia/Kolkata');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', 'old-manager', '2026-08-21', endedAt));
    expect(recipients.of).toHaveBeenCalledWith('u-1');
    expect(notifications.create.mock.calls.map((c: any[]) => c[0].userId)).toEqual([
      'mgr-1',
      'mgr-2',
    ]);
    expect(gateway.emitToUser).toHaveBeenCalledTimes(2);
  });

  it('says nothing when nobody oversees them', async () => {
    recipients.of.mockResolvedValue([]);
    const handle = subscriberWith('Asia/Kolkata');
    await handle(new DayEndedEvent('u-1', 'INDHUJA C', 'mgr-1', '2026-08-21', endedAt));
    expect(notifications.create).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});

describe('OversightRecipients', () => {
  const person = (over: Record<string, unknown>) => ({
    id: 'p',
    role: 'USER',
    companyId: 'org-a',
    departmentId: 'd1',
    ...over,
  });
  function make(p: Record<string, unknown> | null, managers: string[] = [], admins: string[] = []) {
    const people = {
      findById: jest.fn(async () => p),
      listDepartmentManagerIds: jest.fn(async () => managers),
      listOrgAdminIds: jest.fn(async () => admins),
    };
    return { recipients: new OversightRecipients(people as any), people };
  }

  it("Staff: their department's managers", async () => {
    const { recipients } = make(person({}), ['m1', 'm2'], ['adm']);
    await expect(recipients.of('p')).resolves.toEqual(['m1', 'm2']);
  });

  it('Staff in a department without managers (or none): the organisation Admin', async () => {
    await expect(make(person({}), [], ['adm']).recipients.of('p')).resolves.toEqual(['adm']);
    await expect(
      make(person({ departmentId: null }), [], ['adm']).recipients.of('p'),
    ).resolves.toEqual(['adm']);
  });

  it("Managers' own events go to the Admin; Admins' and unassigned people's to nobody", async () => {
    await expect(
      make(person({ role: 'MANAGER' }), ['m1'], ['adm']).recipients.of('p'),
    ).resolves.toEqual(['adm']);
    await expect(make(person({ role: 'ADMIN' }), [], ['adm']).recipients.of('p')).resolves.toEqual(
      [],
    );
    await expect(
      make(person({ companyId: null }), ['m1'], ['adm']).recipients.of('p'),
    ).resolves.toEqual([]);
    await expect(make(null).recipients.of('p')).resolves.toEqual([]);
  });

  it('never notifies the person themselves', async () => {
    await expect(
      make(person({ role: 'MANAGER' }), [], ['p', 'adm']).recipients.of('p'),
    ).resolves.toEqual(['adm']);
  });
});
