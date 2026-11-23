import { ApprovalChangedEvent } from '@shared/events/approval-changed.event';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import { ApprovalRerouteSubscriber } from './approval-reroute.subscriber';

/** 4.0 people: Staff of a department, or a Manager (their own items go to the Admin). */
const person = (id: string, role: string, departmentId: string | null = 'd1') => ({
  id,
  role,
  active: true,
  companyId: 'org-a',
  departmentId,
  managerId: null,
});

/** A pending break of u1, as a row written before 4.0 left it: naming its approver. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  userId: 'u1',
  approverId: 'old' as string | null,
  approverRole: 'MANAGER',
  ...over,
});

function setup(subject = person('u1', 'USER')) {
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };
  const records = {
    // Their own waiting break; nothing waits on them.
    listApprovals: jest.fn(async (q: { userId?: string }) => (q.userId ? [row()] : [])),
    reroute: jest.fn().mockResolvedValue(true),
    findById: jest.fn().mockResolvedValue({ ...row(), approverId: null, overrunReason: null }),
  };
  const people = { findById: jest.fn(async (id: string) => (id === 'u1' ? subject : null)) };
  const events = { approvalRequested: jest.fn().mockResolvedValue(undefined) };
  const sub = new ApprovalRerouteSubscriber(
    bus as never,
    records as never,
    people as never,
    events as never,
  );
  return { sub, bus, records, events };
}

const roleChange = () => new UserAccessChangedEvent('u1', ['ROLE'], new Date());

describe('ApprovalRerouteSubscriber: who hears a change of route (3.6 on 4.0)', () => {
  it('the row moves first, then the item is announced; an approver it named is told by name', async () => {
    const { sub, bus, records, events } = setup();
    await sub.handle(roleChange());
    // 4.0 routes by department: no one person is written.
    expect(records.reroute).toHaveBeenCalledWith('b1', {
      approverRole: 'MANAGER',
      approverId: null,
    });
    expect(bus.publish).toHaveBeenCalledTimes(1);
    const [name, event] = bus.publish.mock.calls[0] as [string, ApprovalChangedEvent];
    expect(name).toBe(ApprovalChangedEvent.eventName);
    expect(event).toMatchObject({
      what: 'BREAK',
      id: 'b1',
      action: 'UPDATED',
      formerApprovers: ['old'],
    });
    // A read before the move would still show the old route.
    expect(records.reroute.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
    // The push for the new route comes from the approval request it raises.
    expect(events.approvalRequested).toHaveBeenCalledTimes(1);
  });

  it('Staff made a Manager: their breaks go to the Admin, and nobody is named', async () => {
    const { sub, bus, records } = setup(person('u1', 'MANAGER'));
    records.listApprovals.mockImplementation(async (q: { userId?: string }) =>
      q.userId ? [row({ approverId: null })] : [],
    );
    await sub.handle(roleChange());
    expect(records.reroute).toHaveBeenCalledWith('b1', { approverRole: 'ADMIN', approverId: null });
    expect(bus.publish.mock.calls[0][1]).toMatchObject({ formerApprovers: [] });
  });

  it('nothing moved, nobody told', async () => {
    const { sub, bus, records } = setup();
    records.reroute.mockResolvedValue(false);
    await sub.handle(roleChange());
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
