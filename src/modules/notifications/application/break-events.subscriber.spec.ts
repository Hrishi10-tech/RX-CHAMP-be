import { InMemoryEventBus } from '@shared/events/in-memory-event-bus';
import { ApprovalRerouteSubscriber } from '@modules/shifts/application/approval-reroute.subscriber';
import { BreakEvents } from '@modules/shifts/application/break-events.service';
import { BreakRecordRow } from '@modules/shifts/domain/break-record.repository';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import { BreakEventsSubscriber } from './break-events.subscriber';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 5, h, m) - 330 * 60_000);
};

const record = (over: Partial<BreakRecordRow>): BreakRecordRow =>
  ({
    id: 'b1',
    userId: 'u1',
    date: '2026-11-05',
    kind: 'LUNCH',
    presenceType: 'LUNCH',
    startedAt: ist('14:00'),
    timing: 'ON_TIME',
    minutesOff: 0,
    reason: null,
    overrunReason: null,
    durationMin: 30,
    outcome: 'TAKEN',
    overrunAsked: false,
    overrunSec: 0,
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: 'new',
    decisionNote: null,
    ...over,
  }) as BreakRecordRow;

/** 4.0 people: u1 is Staff of department d1, whose manager is "new". */
const person = (id: string, role: string) => ({
  id,
  firstName: 'Maya',
  lastName: 'R',
  role,
  active: true,
  companyId: 'org-a',
  departmentId: 'd1',
  managerId: null,
});

/** The real bus, the real events service and the real subscriber; only storage is a stand-in. */
function setup(row: BreakRecordRow) {
  const bus = new InMemoryEventBus();
  const saved: { userId: string; type: string; title: string; body: string }[] = [];
  const everyone: Record<string, unknown> = {
    u1: person('u1', 'USER'),
    new: person('new', 'MANAGER'),
  };
  const people = {
    findById: jest.fn(async (id: string) => everyone[id] ?? null),
    listDepartmentManagerIds: jest.fn(async () => ['new']),
    listOrgAdminIds: jest.fn(async () => []),
  };
  new BreakEventsSubscriber(
    bus,
    {
      create: jest.fn(async (n: { userId: string; type: string; title: string; body: string }) => {
        saved.push(n);
        return { id: 'n1', readAt: null, createdAt: new Date(), fromUserId: null, ...n };
      }),
    } as never,
    { emitToUser: jest.fn() } as never,
  ).onModuleInit();
  const events = new BreakEvents(bus, people as never);
  const records = {
    listApprovals: jest.fn(async (q: { userId?: string }) =>
      q.userId ? [{ ...row, approverId: 'old' }] : [],
    ),
    reroute: jest.fn().mockResolvedValue(true),
    findById: jest.fn().mockResolvedValue(row),
  };
  const reroute = new ApprovalRerouteSubscriber(bus, records as never, people as never, events);
  return { events, reroute, saved };
}

/** Sends the record to its new approver, as a change of manager does. */
async function rerouted(row: BreakRecordRow) {
  const { reroute, saved } = setup(row);
  await reroute.handle(new UserAccessChangedEvent('u1', ['MANAGER'], new Date()));
  await new Promise((done) => setImmediate(done));
  return saved;
}

describe('a pending record sent again to a new approver reads as what it is', () => {
  it('C-868, C-869: a skip with a reason, whatever its timing', async () => {
    for (const timing of ['ON_TIME', 'LATE', 'EARLY'] as const) {
      expect(
        await rerouted(
          record({ outcome: 'SKIPPED', timing, minutesOff: 12, reason: 'Client call at noon' }),
        ),
      ).toEqual([
        expect.objectContaining({
          userId: 'new',
          type: 'SKIP_REQUESTED',
          title: 'Maya R skipped the lunch break',
          body: 'Reason: Client call at noon. Review it in Approvals.',
        }),
      ]);
    }
  });

  it('C-868, C-865: a skip with no reason', async () => {
    expect(await rerouted(record({ outcome: 'SKIPPED', timing: 'LATE', minutesOff: 12 }))).toEqual([
      expect.objectContaining({
        type: 'SKIP_REQUESTED',
        title: 'Maya R skipped the lunch break',
        body: 'Review it in Approvals. No note yet.',
      }),
    ]);
  });

  it('C-870, C-871: an auto-skip names the time, on the 12 hour clock', async () => {
    expect(await rerouted(record({ outcome: 'AUTO_SKIPPED', timing: 'OUTSIDE_WINDOW' }))).toEqual([
      expect.objectContaining({
        type: 'AUTO_SKIP_REQUESTED',
        title: "Maya R's lunch break was skipped automatically",
        body: 'No break was taken by 2:00 PM. Review it in Approvals.',
      }),
    ]);
  });

  it('C-861: a break taken stays a break taken', async () => {
    expect(await rerouted(record({ timing: 'LATE', minutesOff: 12 }))).toEqual([
      expect.objectContaining({
        type: 'BREAK_APPROVAL_REQUESTED',
        title: 'Maya R started the lunch break 12 min after its time',
      }),
    ]);
  });
});

describe('a break with no kind reads "unscheduled break", with no article', () => {
  const plain = { kind: null, presenceType: 'BREAK', timing: 'OUTSIDE_WINDOW' } as const;

  it.each([
    ['APPROVED', 'Your unscheduled break on 5 Nov was approved'],
    ['REJECTED', 'Your unscheduled break on 5 Nov was not approved'],
  ] as const)('C-803, C-804: decided %s', async (approvalStatus, title) => {
    const { events, saved } = setup(record(plain));
    await events.decided(record({ ...plain, approvalStatus }), { id: 'new', name: 'Bala K' });
    await new Promise((done) => setImmediate(done));
    expect(saved).toEqual([expect.objectContaining({ type: 'BREAK_DECIDED', title })]);
  });

  it('C-860: extended', async () => {
    const row = record({ ...plain, overrunAsked: true, overrunReason: 'Client call ran on' });
    const { events, saved } = setup(row);
    await events.approvalRequested(row, person('u1', 'USER') as never, true);
    await new Promise((done) => setImmediate(done));
    expect(saved).toEqual([
      expect.objectContaining({
        type: 'BREAK_APPROVAL_REQUESTED',
        title: "Maya R's unscheduled break was extended",
        body: 'Reason: Client call ran on',
      }),
    ]);
  });
});
