import { LiveActivityUpdate } from '../application/activity.types';
import { ActivityGateway } from './activity.gateway';

/** 4.0 (docs/4.0/SPEC.md 1.2): the live board push follows the manager grants. */
function setup(rooms: string[]) {
  const access = {
    track: jest.fn(),
    roomsOfUser: jest.fn().mockResolvedValue(rooms),
  };
  const gateway = new ActivityGateway({} as never, {} as never, access as never);
  const sent: { rooms: string[]; event: string; payload: LiveActivityUpdate }[] = [];
  (gateway as unknown as { server: unknown }).server = {
    to: (r: string | string[]) => ({
      emit: (event: string, payload: LiveActivityUpdate) =>
        sent.push({ rooms: Array.isArray(r) ? r : [r], event, payload }),
    }),
  };
  return { gateway, sent };
}

const update: LiveActivityUpdate = {
  id: 'u1',
  firstName: 'Staff',
  lastName: 'One',
  email: 'staff1@example.test',
  department: 'Billing',
  managerId: null,
  status: 'ACTIVE',
  app: 'Outlook',
  title: 'Re: salary review',
  url: 'mail.example.com',
  lastSampleAt: '2026-10-20T05:00:00.000Z',
  loginAt: null,
  activeSec: 5400,
  idleSec: 600,
  topApps: [{ name: 'Outlook', seconds: 3000 }],
} as unknown as LiveActivityUpdate;

describe('ActivityGateway.emitForSubject (4.0 grants)', () => {
  it('the whole push to the admins and to managers with both grants; each part to managers with one', async () => {
    const { gateway, sent } = setup(['org:c1', 'dept:d1']);
    await gateway.emitForSubject('u1', update);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      rooms: ['org:c1', 'dept:d1'],
      event: 'activity:update',
      payload: update,
    });
    const timeline = sent.find((s) => s.rooms[0] === 'dept:d1|timeline')!;
    expect(timeline.payload).toMatchObject({
      app: 'Outlook',
      title: 'Re: salary review',
      activeSec: 0,
      idleSec: 0,
    });
    expect(timeline.payload.topApps).toHaveLength(1);
    const activity = sent.find((s) => s.rooms[0] === 'dept:d1|activity')!;
    expect(activity.payload).toMatchObject({
      app: null,
      title: null,
      url: null,
      topApps: [],
      activeSec: 5400,
      idleSec: 600,
    });
  });

  it('a subject with no department (a Manager, or Staff without one): the admins only', async () => {
    const { gateway, sent } = setup(['org:c1']);
    await gateway.emitForSubject('u1', update);
    expect(sent.map((s) => s.rooms)).toEqual([['org:c1']]);
  });

  it('nobody to tell: nothing sent', async () => {
    const { gateway, sent } = setup([]);
    await gateway.emitForSubject('u1', update);
    expect(sent).toEqual([]);
  });
});
