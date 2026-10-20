import { SocketAccessService } from './socket-access.service';

/**
 * 4.0 live rooms per grant (docs/4.0/SPEC.md 1.2, 1.4): what a portal socket joins
 * in each namespace. A Manager with no grant joins nothing; activity is split into
 * the timeline part and the activity part.
 */
function setup(row: Record<string, unknown> | null) {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue(row) },
    company: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
  };
  const events = { subscribe: jest.fn(), publish: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(['*']) };
  return new SocketAccessService(prisma as never, events as never, config as never);
}

const manager = (grants: { screenshots?: boolean; timeline?: boolean; activity?: boolean }) => ({
  companyId: 'c1',
  grantScreenshots: grants.screenshots ?? false,
  grantTimeline: grants.timeline ?? false,
  grantActivity: grants.activity ?? false,
  role: { name: 'MANAGER' },
  managedDepartments: [{ departmentId: 'd1' }, { departmentId: 'd2' }],
});

describe('SocketAccessService.roomsFor (4.0 grants)', () => {
  it('a Manager with no grant joins no team room in any namespace', async () => {
    const svc = setup(manager({}));
    for (const section of ['presence', 'activity', 'screenshots'] as const) {
      expect(await svc.roomsFor('m1', null, section)).toEqual([]);
    }
  });

  it('presence: any one grant opens the department rooms', async () => {
    for (const g of [{ screenshots: true }, { timeline: true }, { activity: true }]) {
      expect(await setup(manager(g)).roomsFor('m1', null, 'presence')).toEqual([
        'dept:d1',
        'dept:d2',
      ]);
    }
  });

  it('activity: both grants the whole push; one grant its redacted room', async () => {
    expect(
      await setup(manager({ timeline: true, activity: true })).roomsFor('m1', null, 'activity'),
    ).toEqual(['dept:d1', 'dept:d2']);
    expect(await setup(manager({ timeline: true })).roomsFor('m1', null, 'activity')).toEqual([
      'dept:d1|timeline',
      'dept:d2|timeline',
    ]);
    expect(await setup(manager({ activity: true })).roomsFor('m1', null, 'activity')).toEqual([
      'dept:d1|activity',
      'dept:d2|activity',
    ]);
    expect(await setup(manager({ screenshots: true })).roomsFor('m1', null, 'activity')).toEqual(
      [],
    );
  });

  it('screenshots: only with that grant', async () => {
    expect(
      await setup(manager({ timeline: true, activity: true })).roomsFor('m1', null, 'screenshots'),
    ).toEqual([]);
    expect(await setup(manager({ screenshots: true })).roomsFor('m1', null, 'screenshots')).toEqual(
      ['dept:d1', 'dept:d2'],
    );
  });

  it('an Admin gets the organisation room everywhere; Staff nothing', async () => {
    const admin = setup({ companyId: 'c1', role: { name: 'ADMIN' }, managedDepartments: [] });
    for (const section of ['presence', 'activity', 'screenshots'] as const) {
      expect(await admin.roomsFor('a1', null, section)).toEqual(['org:c1']);
    }
    const staff = setup({ companyId: 'c1', role: { name: 'USER' }, managedDepartments: [] });
    expect(await staff.roomsFor('u1', null, 'presence')).toEqual([]);
  });
});
