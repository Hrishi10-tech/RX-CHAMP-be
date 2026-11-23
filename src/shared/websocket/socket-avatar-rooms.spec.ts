import { SocketAccessService } from './socket-access.service';
import {
  ALL_ORGS_ROOM,
  avatarRoomsOf,
  deptRoom,
  deptStaffRoom,
  membersRoom,
  orgRoom,
  PLATFORM_ROOM,
  userRoom,
} from './socket-rooms';

/**
 * 3.6 avatar:changed, 4.0 audience: it reaches the people shown the person (their
 * organisation's admins and the platform roles with it in view, their department's
 * managers, a Manager's Staff, everyone for an Admin) and never another organisation.
 * Both sides are pinned: the rooms a /notifications socket joins (avatarRooms) and
 * the rooms a change is sent to (avatarRoomsOf / avatarAudience).
 */
const ORG = '00000000-0000-0000-0000-0000000000a0';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000b0';

const down = () => Promise.reject(new Error('Timed out fetching a new connection from the pool'));

function setup(user: Record<string, jest.Mock>, company: unknown = { id: ORG }) {
  const prisma = {
    user,
    company: { findFirst: jest.fn().mockResolvedValue(company) },
  };
  const events = { subscribe: jest.fn(), publish: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'jwt.accessTtl' ? '15m' : ['*'])) };
  return new SocketAccessService(prisma as never, events as never, config as never);
}

const row = (role: string, over: Record<string, unknown> = {}) => ({
  companyId: ORG,
  departmentId: null,
  role: { name: role },
  managedDepartments: [],
  ...over,
});

describe('avatar:changed, the sending side (avatarRoomsOf)', () => {
  const subject = (role: string, over: Partial<Parameters<typeof avatarRoomsOf>[0]> = {}) =>
    avatarRoomsOf({
      id: 'u-1',
      role,
      companyId: ORG,
      departmentId: null,
      managedDepartmentIds: [],
      ...over,
    });

  it("Staff: their devices, the organisation's admins, the platform roles, the department's managers", () => {
    expect(subject('USER', { departmentId: 'd1' })).toEqual([
      userRoom('u-1'),
      orgRoom(ORG),
      ALL_ORGS_ROOM,
      deptRoom('d1'),
    ]);
  });

  it('Staff with no department: no department room', () => {
    expect(subject('USER')).toEqual([userRoom('u-1'), orgRoom(ORG), ALL_ORGS_ROOM]);
  });

  it('a Manager: the Staff of the departments they manage, not other managers', () => {
    expect(subject('MANAGER', { departmentId: 'd9', managedDepartmentIds: ['d1', 'd2'] })).toEqual([
      userRoom('u-1'),
      orgRoom(ORG),
      ALL_ORGS_ROOM,
      deptStaffRoom('d1'),
      deptStaffRoom('d2'),
    ]);
  });

  it("an Admin: everyone in the organisation (they are in everyone's Messages)", () => {
    expect(subject('ADMIN')).toEqual([
      userRoom('u-1'),
      orgRoom(ORG),
      ALL_ORGS_ROOM,
      membersRoom(ORG),
    ]);
  });

  it('no organisation (a Super Admin, the Super Manager): the platform roles only', () => {
    for (const role of ['SUPER_ADMIN', 'SUPER_MANAGER']) {
      expect(subject(role, { companyId: null })).toEqual([userRoom('u-1'), PLATFORM_ROOM]);
    }
  });

  it('never names another organisation', () => {
    const rooms = subject('ADMIN');
    expect(rooms.some((r) => r.includes(OTHER_ORG))).toBe(false);
  });
});

describe('avatar:changed, read when sent (avatarAudience)', () => {
  it('reads the person now, managed departments included', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValue(row('MANAGER', { managedDepartments: [{ departmentId: 'd1' }] }));
    await expect(setup({ findUnique }).avatarAudience('u-1')).resolves.toEqual([
      userRoom('u-1'),
      orgRoom(ORG),
      ALL_ORGS_ROOM,
      deptStaffRoom('d1'),
    ]);
  });

  it('only their own devices when the person is gone or the read fails', async () => {
    await expect(
      setup({ findUnique: jest.fn().mockResolvedValue(null) }).avatarAudience('u-1'),
    ).resolves.toEqual([userRoom('u-1')]);
    await expect(setup({ findUnique: jest.fn(down) }).avatarAudience('u-1')).resolves.toEqual([
      userRoom('u-1'),
    ]);
  });
});

describe('avatar:changed, the listening side (avatarRooms at the handshake)', () => {
  const as = (r: Record<string, unknown> | null, company: unknown = { id: ORG }) =>
    setup({ findFirst: jest.fn().mockResolvedValue(r) }, company);

  it('an Admin hears their organisation', async () => {
    await expect(as(row('ADMIN')).avatarRooms('a-1', null)).resolves.toEqual([orgRoom(ORG)]);
  });

  it('a Manager hears their departments, with or without a grant', async () => {
    const m = row('MANAGER', {
      managedDepartments: [{ departmentId: 'd1' }, { departmentId: 'd2' }],
    });
    await expect(as(m).avatarRooms('m-1', null)).resolves.toEqual([deptRoom('d1'), deptRoom('d2')]);
  });

  it("Staff hear their department's Staff room (its managers' changes)", async () => {
    await expect(as(row('USER', { departmentId: 'd1' })).avatarRooms('s-1', null)).resolves.toEqual(
      [deptStaffRoom('d1')],
    );
    await expect(as(row('USER')).avatarRooms('s-1', null)).resolves.toEqual([]);
  });

  it.each(['SUPER_ADMIN', 'SUPER_MANAGER'])(
    '%s hears the organisation in view, or every one on All organisations',
    async (role) => {
      const platform = row(role, { companyId: null });
      await expect(as(platform).avatarRooms('p-1', ORG)).resolves.toEqual([
        PLATFORM_ROOM,
        orgRoom(ORG),
      ]);
      await expect(as(platform).avatarRooms('p-1', null)).resolves.toEqual([
        PLATFORM_ROOM,
        ALL_ORGS_ROOM,
      ]);
      await expect(as(platform).avatarRooms('p-1', 'not-an-id')).resolves.toEqual([
        PLATFORM_ROOM,
        ALL_ORGS_ROOM,
      ]);
      // A deleted or unknown organisation in the handshake: the platform room only.
      await expect(as(platform, null).avatarRooms('p-1', OTHER_ORG)).resolves.toEqual([
        PLATFORM_ROOM,
      ]);
    },
  );

  it('nothing for someone gone, blocked or deleted', async () => {
    await expect(as(null).avatarRooms('u-1', null)).resolves.toEqual([]);
  });

  // handleConnection's promise is dropped by Nest, so a rejection here would end the process.
  it('never rejects: a failed read during a handshake leaves no extra rooms', async () => {
    await expect(setup({ findFirst: jest.fn(down) }).avatarRooms('u-1', null)).resolves.toEqual([]);
  });
});
