import { AvatarCatalog } from '@shared/avatars/avatar-catalog';
import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';
import { AvatarService } from './avatar.service';

const catalog = new AvatarCatalog(
  {
    version: 3,
    default: { male: 'M01', female: 'F01' },
    avatars: [
      { id: 'M01', gender: 'male', set: 1, file: 'male/M01.png' },
      { id: 'M02', gender: 'male', set: 2, file: 'male/M02.png' },
      { id: 'F01', gender: 'female', set: 1, file: 'female/F01.png' },
    ],
  },
  '/nowhere',
);

function user(gender: 'MALE' | 'FEMALE' | null, avatarId: string | null = null): User {
  return User.fromPersistence({
    id: UserId.create('u-1'),
    email: Email.create('u@acme.test'),
    passwordHash: 'h',
    firstName: 'Uma',
    lastName: 'C',
    designation: null,
    role: Role.USER,
    department: null,
    managerId: null,
    companyId: 'co-1',
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status: 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: null,
    createdAt: new Date(),
    gender,
    avatarId,
  });
}

const actor = (role: Role): AuthenticatedUser => ({
  id: 'u-1',
  email: 'u@acme.test',
  role,
  permissions: [],
  department: null,
  companyId: 'co-1',
  status: 'ACTIVE',
});

describe('AvatarService', () => {
  const users = { findById: jest.fn(), save: jest.fn() };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const service = new AvatarService(catalog, users as never, events);

  beforeEach(() => {
    jest.resetAllMocks();
    users.save.mockImplementation((u: User) => Promise.resolve(u));
    events.publish.mockResolvedValue(undefined);
  });

  describe('what you read', () => {
    it('a person with a choice', async () => {
      users.findById.mockResolvedValue(user('MALE', 'M02'));
      await expect(service.mine(actor(Role.USER))).resolves.toEqual({
        avatarId: 'M02',
        chosenAvatarId: 'M02',
        defaultAvatarId: 'M01',
        library: 'male',
      });
    });

    it('a person on their default', async () => {
      users.findById.mockResolvedValue(user('FEMALE'));
      await expect(service.mine(actor(Role.USER))).resolves.toEqual({
        avatarId: 'F01',
        chosenAvatarId: null,
        defaultAvatarId: 'F01',
        library: 'female',
      });
    });

    it('a person with no gender yet has nothing', async () => {
      users.findById.mockResolvedValue(user(null));
      await expect(service.mine(actor(Role.USER))).resolves.toEqual({
        avatarId: null,
        chosenAvatarId: null,
        defaultAvatarId: null,
        library: null,
      });
    });
  });

  describe('choosing', () => {
    it('stores the ID and tells every device', async () => {
      users.findById.mockResolvedValue(user('MALE'));
      const view = await service.choose(actor(Role.USER), 'M02');
      expect(view.avatarId).toBe('M02');
      expect(users.save.mock.calls[0][0].avatarId).toBe('M02');
      expect(events.publish).toHaveBeenCalledWith(
        AvatarChangedEvent.eventName,
        new AvatarChangedEvent('u-1', 'M02', 'co-1'),
      );
    });

    it('refuses an ID that is not in the manifest', async () => {
      users.findById.mockResolvedValue(user('MALE'));
      await expect(service.choose(actor(Role.MANAGER), 'M99')).rejects.toMatchObject({
        status: 400,
        code: 'AVATAR_UNKNOWN',
      });
      expect(users.save).not.toHaveBeenCalled();
    });

    it("refuses the other gender's avatar", async () => {
      users.findById.mockResolvedValue(user('MALE'));
      await expect(service.choose(actor(Role.MANAGER), 'F01')).rejects.toMatchObject({
        status: 403,
        code: 'AVATAR_OTHER_LIBRARY',
      });
      expect(users.save).not.toHaveBeenCalled();
    });

    it('asks for the gender first', async () => {
      users.findById.mockResolvedValue(user(null));
      await expect(service.choose(actor(Role.MANAGER), 'M01')).rejects.toMatchObject({
        status: 409,
        code: 'GENDER_NOT_SET',
      });
    });

    // 4.1: Staff have the portal, so nobody is limited to the agent or the phone any more.
    it.each([Role.USER, Role.MANAGER, Role.SUPER_MANAGER, Role.SUPER_ADMIN])(
      'lets %s change it from any client',
      async (role) => {
        users.findById.mockResolvedValue(user('MALE'));
        await expect(service.choose(actor(role), 'M02')).resolves.toMatchObject({
          avatarId: 'M02',
        });
      },
    );
  });

  describe('resetting', () => {
    it('goes back to the default and tells every device', async () => {
      users.findById.mockResolvedValue(user('MALE', 'M02'));
      const view = await service.resetMine(actor(Role.USER));
      expect(view).toMatchObject({ avatarId: 'M01', chosenAvatarId: null });
      expect(events.publish).toHaveBeenCalledWith(
        AvatarChangedEvent.eventName,
        new AvatarChangedEvent('u-1', 'M01', 'co-1'),
      );
    });

    // 4.0: whoever may set the person's gender (their organisation admin, a Super Admin).
    const admin = (role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
      ...actor(role),
      id: 'a-1',
      ...over,
    });

    it("resets someone else's for a Super Admin in their organisation", async () => {
      users.findById.mockResolvedValue(user('FEMALE', 'F02'));
      await expect(
        service.resetFor(admin(Role.SUPER_ADMIN, { companyId: null, orgId: 'co-1' }), 'u-1'),
      ).resolves.toEqual({ userId: 'u-1', avatarId: 'F01' });
      expect(users.save.mock.calls[0][0].avatarId).toBeNull();
      expect(events.publish).toHaveBeenCalledWith(
        AvatarChangedEvent.eventName,
        new AvatarChangedEvent('u-1', 'F01', 'co-1'),
      );
    });

    it("resets their own organisation's Staff for an Admin", async () => {
      users.findById.mockResolvedValue(user('MALE', 'M02'));
      await expect(service.resetFor(admin(Role.ADMIN), 'u-1')).resolves.toEqual({
        userId: 'u-1',
        avatarId: 'M01',
      });
    });

    it("answers 404 for another organisation's person, as for someone unknown", async () => {
      users.findById.mockResolvedValue(user('MALE', 'M02'));
      await expect(
        service.resetFor(admin(Role.ADMIN, { companyId: 'co-2' }), 'u-1'),
      ).rejects.toMatchObject({ status: 404 });
      users.findById.mockResolvedValue(null);
      await expect(service.resetFor(admin(Role.ADMIN), 'nobody')).rejects.toMatchObject({
        status: 404,
      });
      expect(users.save).not.toHaveBeenCalled();
    });

    it('refuses the Super Manager, who edits Staff but never sets gender', async () => {
      users.findById.mockResolvedValue(user('MALE', 'M02'));
      await expect(
        service.resetFor(admin(Role.SUPER_MANAGER, { companyId: null, orgId: 'co-1' }), 'u-1'),
      ).rejects.toMatchObject({ status: 403, code: 'AVATAR_RESET_FORBIDDEN' });
      expect(users.save).not.toHaveBeenCalled();
    });
  });

  describe('the manifest', () => {
    it('gives version, defaults and every avatar with a URL per size', () => {
      const view = service.manifest('api/v1');
      expect(view.version).toBe(3);
      expect(view.defaults).toEqual({ male: 'M01', female: 'F01' });
      expect(view.avatars.map((a) => a.id)).toEqual(['M01', 'M02', 'F01']);
      expect(view.avatars[1]).toEqual({
        id: 'M02',
        gender: 'male',
        set: 2,
        files: {
          '48': '/api/v1/avatars/files/48/M02.webp',
          '96': '/api/v1/avatars/files/96/M02.webp',
          '144': '/api/v1/avatars/files/144/M02.webp',
          '192': '/api/v1/avatars/files/192/M02.webp',
        },
      });
    });
  });
});
