import { ApprovalChangedEvent } from '@shared/events/approval-changed.event';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import { MeetingRerouteSubscriber } from './meeting-reroute.subscriber';

/** Staff of a department made a Manager: their own items now wait on the Admin (4.0). */
const promoted = {
  id: 'u1',
  role: 'MANAGER',
  active: true,
  companyId: 'org-a',
  departmentId: 'd1',
};

function setup(endedAt: Date | null, approverId: string | null = 'old') {
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const row = { id: 'm1', userId: 'u1', approverId, approverRole: 'MANAGER', endedAt };
  const meetings = {
    listPendingForApprover: jest.fn().mockResolvedValue([]),
    listPendingForUser: jest.fn().mockResolvedValue([row]),
    reroute: jest.fn().mockResolvedValue(true),
  };
  const away = { reroutePending: jest.fn().mockResolvedValue(0) };
  const people = { findById: jest.fn(async (id: string) => (id === 'u1' ? promoted : null)) };
  const sub = new MeetingRerouteSubscriber(
    away as never,
    bus as never,
    meetings as never,
    people as never,
  );
  return { sub, bus, meetings, away };
}

const roleChange = () => new UserAccessChangedEvent('u1', ['ROLE'], new Date());

describe('MeetingRerouteSubscriber: who hears a change of route (3.6 on 4.0)', () => {
  it('one that can be decided is new to whom it waits on now, after the move', async () => {
    const { sub, bus, meetings } = setup(new Date());
    await sub.handle(roleChange());
    expect(meetings.reroute).toHaveBeenCalledWith('m1', {
      approverRole: 'ADMIN',
      approverId: null,
    });
    expect(bus.publish).toHaveBeenCalledTimes(1);
    const [name, event] = bus.publish.mock.calls[0] as [string, ApprovalChangedEvent];
    expect(name).toBe(ApprovalChangedEvent.eventName);
    // A row written before 4.0 names its approver, who is told by name.
    expect(event).toMatchObject({
      what: 'MEETING',
      id: 'm1',
      action: 'CREATED',
      formerApprovers: ['old'],
    });
    expect(meetings.reroute.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
  });

  it('one still running only moves: its request comes when it ends', async () => {
    const { sub, bus } = setup(null, null);
    await sub.handle(roleChange());
    expect(bus.publish.mock.calls[0][1]).toMatchObject({
      action: 'UPDATED',
      formerApprovers: [],
    });
  });

  it('nothing moved, nobody told', async () => {
    const { sub, bus, meetings } = setup(new Date());
    meetings.reroute.mockResolvedValue(false);
    await sub.handle(roleChange());
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
