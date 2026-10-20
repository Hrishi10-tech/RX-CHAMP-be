import { LegacyBreakSubscriber } from './legacy-break.subscriber';
import { BreakDayService } from './break-day.service';
import { PresenceStartedEvent } from '@modules/presence/domain/events/presence-started.event';
import { ShiftRecord } from '../domain/shift.types';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60_000);
};

const general: ShiftRecord = {
  id: 'g',
  companyId: null,
  isDefault: true,
  name: 'General',
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5, 6],
  ringLeadMin: 1,
  ringDurationMin: 5,
  ringSound: true,
  reasonOnEarly: true,
  reasonOnLate: true,
  reasonMinChars: 10,
  overrunReason: false,
  overrunGraceMin: 2,
  breaks: [
    {
      kind: 'MORNING',
      enabled: true,
      startTime: '11:00',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'LUNCH',
      enabled: true,
      startTime: '13:00',
      durationMin: 30,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'EVENING',
      enabled: true,
      startTime: '16:00',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('LegacyBreakSubscriber', () => {
  const bus = { subscribe: jest.fn(), publish: jest.fn() } as any;
  const records = { listForUserOnDate: jest.fn(), createForSession: jest.fn() } as any;
  // Who fires the presence event: staff in a department unless a test changes it.
  let subject: Record<string, unknown> = {};
  const people = {
    findById: jest.fn(async (id: string) =>
      id === 'mgr'
        ? { id: 'mgr', role: 'MANAGER', active: true, firstName: 'M', lastName: '', companyId: 'org-a', departmentId: 'dept-1' }
        : {
            id,
            role: 'USER',
            active: true,
            managerId: 'mgr',
            companyId: 'org-a',
            department: 'Engineering',
            departmentId: 'dept-1',
            firstName: 'S',
            lastName: '',
            ...subject,
          },
    ),
  } as any;
  const shifts = {
    list: jest.fn(async () => [general]),
    listAssignmentsFor: jest.fn(async () => []),
    listAllAssignments: jest.fn(async () => []),
  } as any;
  const events = { approvalRequested: jest.fn() } as any;
  let sub: LegacyBreakSubscriber;

  beforeEach(() => {
    jest.clearAllMocks();
    subject = {};
    records.listForUserOnDate.mockResolvedValue([]);
    records.createForSession.mockImplementation(async (r: any) => ({ ...r, id: 'new' }));
    sub = new LegacyBreakSubscriber(bus, records, people, new BreakDayService(shifts), events);
  });

  const fire = (type: 'BREAK' | 'LUNCH' | 'MEETING', hm: string) =>
    sub.handle(new PresenceStartedEvent('staff', 'session-1', type, ist(hm)));

  it('records an on-time morning break with no approval', async () => {
    await fire('BREAK', '11:01');
    expect(records.createForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'MORNING',
        timing: 'ON_TIME',
        approvalStatus: 'NOT_REQUIRED',
        source: 'LEGACY',
      }),
      'session-1',
    );
    expect(events.approvalRequested).not.toHaveBeenCalled();
  });

  it("sends a late lunch to the department's managers without a reason (older agents cannot give one)", async () => {
    await fire('LUNCH', '13:25');
    expect(records.createForSession.mock.calls[0][0]).toMatchObject({
      kind: 'LUNCH',
      timing: 'LATE',
      minutesOff: 25,
      reason: null,
      approvalStatus: 'PENDING',
      approverRole: 'MANAGER',
      // 4.0: routed by department, never to the 3.x reporting manager by id.
      approverId: null,
    });
    expect(events.approvalRequested).toHaveBeenCalled();
  });

  it('sends staff without a department, and managers, to the organisation Admin', async () => {
    subject = { departmentId: null };
    await fire('LUNCH', '13:25');
    expect(records.createForSession.mock.calls[0][0]).toMatchObject({
      approvalStatus: 'PENDING',
      approverRole: 'ADMIN',
      approverId: null,
    });
    subject = { role: 'MANAGER' };
    await fire('BREAK', '14:30');
    expect(records.createForSession.mock.calls[1][0]).toMatchObject({
      timing: 'OUTSIDE_WINDOW',
      approvalStatus: 'PENDING',
      approverRole: 'ADMIN',
      approverId: null,
    });
    expect(events.approvalRequested).toHaveBeenCalledTimes(2);
  });

  it("records an Admin's off-schedule break with nothing to approve", async () => {
    subject = { role: 'ADMIN', departmentId: null };
    await fire('BREAK', '14:30');
    expect(records.createForSession.mock.calls[0][0]).toMatchObject({
      timing: 'OUTSIDE_WINDOW',
      approvalStatus: 'NOT_REQUIRED',
      approverRole: null,
      approverId: null,
    });
    expect(events.approvalRequested).not.toHaveBeenCalled();
  });

  it('flags a break outside every window', async () => {
    await fire('BREAK', '14:30');
    expect(records.createForSession.mock.calls[0][0]).toMatchObject({
      kind: null,
      timing: 'OUTSIDE_WINDOW',
      approvalStatus: 'PENDING',
      approverRole: 'MANAGER',
      approverId: null,
    });
  });

  it('flags a second morning break as off schedule', async () => {
    records.listForUserOnDate.mockResolvedValue([{ kind: 'MORNING' }]);
    await fire('BREAK', '11:30');
    expect(records.createForSession.mock.calls[0][0]).toMatchObject({
      kind: null,
      timing: 'OUTSIDE_WINDOW',
    });
  });

  it('ignores meetings and free days', async () => {
    await fire('MEETING', '11:00');
    shifts.list.mockResolvedValueOnce([]);
    await fire('BREAK', '11:00');
    expect(records.createForSession).not.toHaveBeenCalled();
  });
});
