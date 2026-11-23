import { ApprovalChangedEvent, ApprovalWhat } from '@shared/events/approval-changed.event';
import { NoticeEvent } from '@shared/events/notice.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { BreakApprovalRequestedEvent } from '@modules/shifts/domain/events/break-approval-requested.event';
import { approvalPushCopy } from '../domain/approval-push-copy';
import { ApprovalSyncSubscriber } from './approval-sync.subscriber';

function setup(audience: unknown) {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const events = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn((name: string, h: (p: unknown) => unknown) => handlers.set(name, h)),
  };
  const audiences = {
    of: jest.fn().mockResolvedValue(audience),
    movedBy: jest.fn().mockResolvedValue([]),
  };
  const gateway = { emitApprovals: jest.fn() };
  const push = { send: jest.fn().mockResolvedValue('NOT_SENT') };
  const sub = new ApprovalSyncSubscriber(
    events as never,
    audiences as never,
    gateway as never,
    push as never,
  );
  sub.onModuleInit();
  return { sub, events, audiences, gateway, push, handlers };
}

const waiting = { status: 'PENDING', deciders: ['m1'], viewers: ['u1', 'm1', 'sa1', 'sm1'] };

describe('ApprovalSyncSubscriber (3.6)', () => {
  it('tells the deciders it needs them and everyone else it changed', async () => {
    const { sub, gateway } = setup(waiting);
    await sub.handle(new ApprovalChangedEvent('LEAVE', 'l1', 'CREATED', 'T'));
    expect(gateway.emitApprovals).toHaveBeenCalledWith(['m1'], {
      what: 'LEAVE',
      id: 'l1',
      action: 'CREATED',
      at: 'T',
      needsYou: true,
    });
    expect(gateway.emitApprovals).toHaveBeenCalledWith(['u1', 'sa1', 'sm1'], {
      what: 'LEAVE',
      id: 'l1',
      action: 'CREATED',
      at: 'T',
      needsYou: false,
    });
  });

  it('once decided, it needs nobody', async () => {
    const { sub, gateway, push } = setup({ ...waiting, status: 'APPROVED' });
    await sub.handle(new ApprovalChangedEvent('WFH', 'w1', 'DECIDED', 'T'));
    expect(gateway.emitApprovals).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ needsYou: true }),
    );
    expect(gateway.emitApprovals).toHaveBeenCalledWith(
      ['u1', 'm1', 'sa1', 'sm1'],
      expect.objectContaining({ what: 'WFH', id: 'w1', action: 'DECIDED', needsYou: false }),
    );
    expect(push.send).not.toHaveBeenCalled();
  });

  it('whoever it was routed to until now hears it too, though it no longer needs them', async () => {
    const { sub, gateway } = setup(waiting);
    await sub.handle(new ApprovalChangedEvent('BREAK', 'b1', 'UPDATED', 'T', ['former', 'sa1']));
    expect(gateway.emitApprovals).toHaveBeenCalledWith(
      ['m1'],
      expect.objectContaining({ needsYou: true }),
    );
    expect(gateway.emitApprovals).toHaveBeenCalledWith(['u1', 'sa1', 'sm1', 'former'], {
      what: 'BREAK',
      id: 'b1',
      action: 'UPDATED',
      at: 'T',
      needsYou: false,
    });
  });

  it('someone routed away who is now the decider is told once, that it needs them', async () => {
    const { sub, gateway } = setup(waiting);
    await sub.handle(new ApprovalChangedEvent('BREAK', 'b1', 'UPDATED', 'T', ['m1']));
    const told = gateway.emitApprovals.mock.calls.flatMap(([ids]: [string[]]) => ids);
    expect(told.filter((id: string) => id === 'm1')).toHaveLength(1);
    expect(gateway.emitApprovals).toHaveBeenCalledWith(
      ['m1'],
      expect.objectContaining({ needsYou: true }),
    );
  });

  it('says nothing about an item nobody can see', async () => {
    const { sub, gateway, push } = setup(null);
    await sub.handle(new ApprovalChangedEvent('MEETING', 'm1', 'CREATED'));
    expect(gateway.emitApprovals).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });

  it.each<ApprovalWhat>(['BREAK', 'MEETING', 'AWAY', 'LEAVE', 'WFH', 'COMPOFF'])(
    'a new %s pushes to each decider, naming only the kind of request',
    async (what) => {
      const { sub, push } = setup({ ...waiting, deciders: ['sa1', 'sa2'] });
      await sub.handle(new ApprovalChangedEvent(what, 'x1', 'CREATED'));
      expect(push.send.mock.calls.map(([m]) => m.recipientId)).toEqual(['sa1', 'sa2']);
      expect(push.send.mock.calls[0][0]).toEqual({
        recipientId: 'sa1',
        ...approvalPushCopy(what),
        data: { type: 'APPROVAL_REQUEST', what, id: 'x1' },
      });
    },
  );

  it.each(['DECIDED', 'REVOKED', 'REOPENED', 'CANCELLED', 'UPDATED'] as const)(
    'no push when it is %s',
    async (action) => {
      const { sub, push } = setup(waiting);
      await sub.handle(new ApprovalChangedEvent('BREAK', 'b1', action));
      expect(push.send).not.toHaveBeenCalled();
    },
  );

  it('a request approved at once pushes to nobody', async () => {
    const { sub, push } = setup({ status: 'APPROVED', deciders: [], viewers: ['u1'] });
    await sub.handle(new ApprovalChangedEvent('LEAVE', 'l1', 'CREATED'));
    expect(push.send).not.toHaveBeenCalled();
  });

  it('a break waiting for a decision is announced as new', async () => {
    const { events, handlers } = setup(waiting);
    await handlers.get(BreakApprovalRequestedEvent.eventName)!(
      new BreakApprovalRequestedEvent(
        'b9',
        'u1',
        'Asha',
        ['m1'],
        'LUNCH',
        'LATE',
        20,
        null,
        false,
        new Date(),
      ),
    );
    expect(events.publish).toHaveBeenCalledWith(
      ApprovalChangedEvent.eventName,
      expect.objectContaining({ what: 'BREAK', id: 'b9', action: 'CREATED' }),
    );
  });

  it('a notice that names its item announces that change', async () => {
    const { events, handlers } = setup(waiting);
    await handlers.get(NoticeEvent.eventName)!(
      new NoticeEvent(['m1'], 'MEETING_REQUESTED', 't', 'b', 'u1', {
        what: 'MEETING',
        id: 'm9',
        action: 'CREATED',
      }),
    );
    expect(events.publish).toHaveBeenCalledWith(
      ApprovalChangedEvent.eventName,
      expect.objectContaining({ what: 'MEETING', id: 'm9', action: 'CREATED' }),
    );
  });

  describe('4.0: a change of who decides, by department', () => {
    it('announces each item as movedBy says, naming whoever it left', async () => {
      const { events, handlers, audiences } = setup(waiting);
      audiences.movedBy.mockResolvedValue([
        { what: 'LEAVE', id: 'l1', action: 'CREATED', formerApprovers: ['mgr-old'] },
        { what: 'AWAY', id: 'a1', action: 'UPDATED', formerApprovers: [] },
      ]);
      const change = new UserAccessChangedEvent('u1', ['ROLE'], new Date(), true, {
        role: 'USER',
        departmentId: 'd-old',
        managedDepartmentIds: [],
      });
      await handlers.get(UserAccessChangedEvent.eventName)!(change);
      expect(audiences.movedBy).toHaveBeenCalledWith(change);
      expect(events.publish).toHaveBeenCalledTimes(2);
      expect(events.publish).toHaveBeenCalledWith(
        ApprovalChangedEvent.eventName,
        expect.objectContaining({
          what: 'LEAVE',
          id: 'l1',
          action: 'CREATED',
          formerApprovers: ['mgr-old'],
        }),
      );
      expect(events.publish).toHaveBeenCalledWith(
        ApprovalChangedEvent.eventName,
        expect.objectContaining({ what: 'AWAY', id: 'a1', action: 'UPDATED', formerApprovers: [] }),
      );
    });

    it('nothing moved, nothing said', async () => {
      const { events, handlers } = setup(waiting);
      await handlers.get(UserAccessChangedEvent.eventName)!(
        new UserAccessChangedEvent('u1', ['PASSWORD'], new Date()),
      );
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  it('4.0: away time sent for approval is announced as new, and pushed to its deciders', async () => {
    const { sub, events, handlers, push } = setup({ ...waiting, deciders: ['mgr-a'] });
    await handlers.get(NoticeEvent.eventName)!(
      new NoticeEvent(['mgr-a'], 'AWAY_REQUESTED', 't', 'b', 'u1', {
        what: 'AWAY',
        id: 'a9',
        action: 'CREATED',
      }),
    );
    const [, event] = events.publish.mock.calls[0] as [string, ApprovalChangedEvent];
    expect(event).toMatchObject({ what: 'AWAY', id: 'a9', action: 'CREATED' });
    await sub.handle(event);
    expect(push.send).toHaveBeenCalledWith({
      recipientId: 'mgr-a',
      title: 'Away time is waiting for you',
      body: 'Open RX Vision to review it.',
      data: { type: 'APPROVAL_REQUEST', what: 'AWAY', id: 'a9' },
    });
  });

  it('any other notice is left alone', async () => {
    const { events, handlers } = setup(waiting);
    await handlers.get(NoticeEvent.eventName)!(new NoticeEvent(['m1'], 'CHAT_MESSAGE', 't', 'b'));
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe('approvalPushCopy (3.6)', () => {
  it.each<ApprovalWhat>(['BREAK', 'MEETING', 'AWAY', 'LEAVE', 'WFH', 'COMPOFF'])(
    '%s reads calmly, in sentence case, with no exclamation mark or dash',
    (what) => {
      const { title, body } = approvalPushCopy(what);
      expect(title).toMatch(/^(A|Away) [a-z ]+ is waiting for you$/);
      expect(body).toBe('Open RX Vision to review it.');
      expect(`${title} ${body}`).not.toMatch(/[!—–]/);
    },
  );
});
