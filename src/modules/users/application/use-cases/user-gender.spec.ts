// 3.6 gender and the avatar on the people screens, fitted to 4.0: gender is set (and
// seen) by whoever edits the person as their organisation admin or a Super Admin
// (canSetGender), never by the Super Manager, a Manager or Staff.
import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  DEPT_A1,
  IDS,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
  superManager,
} from '@shared/testing/actors.testing-spec';
import { User } from '../../domain/entities/user.entity';
import { canSetGender } from '../../domain/services/user-access.service';
import { cast, fakeDepartments, fakeUsers, person } from '../../testing/people.testing-spec';
import { UserMapper } from '../mappers/user.mapper';
import { CreateUsersUseCase } from './create-users.use-case';
import { GetProfileUseCase } from './get-profile.use-case';
import { ListUsersUseCase } from './list-users.use-case';
import { UpdateUserUseCase } from './update-user.use-case';

const PASSWORD = 'S3cure!pass';
const maleOnM12 = (over: Parameters<typeof person>[0] = {}) =>
  person({ gender: 'MALE', avatarId: 'M12', ...over });

describe('who may set (and so see) a gender', () => {
  const people = cast();
  const managerA1 = person({ id: IDS.managerA1, role: Role.MANAGER, managed: [DEPT_A1] });
  const superManagerAccount = person({
    id: IDS.superManager,
    role: Role.SUPER_MANAGER,
    companyId: null,
    departmentId: null,
  });

  it.each<[string, AuthenticatedUser, User, boolean]>([
    ['an Admin, their Staff', admin(), people.staffA1, true],
    ['an Admin, their Manager', admin(), managerA1, true],
    ['an Admin, another organisation', admin(ORG_B), people.staffA1, false],
    ['an Admin, themselves', admin(), people.adminA, false],
    ['a Super Admin, an Admin', superAdmin(ORG_A), people.adminA, true],
    ['a Super Admin on All organisations, Staff', superAdmin(null), people.staffB1, true],
    ['a Super Admin, the Super Manager', superAdmin(null), superManagerAccount, true],
    ['a Super Admin, themselves', superAdmin(null), people.superAdmin, true],
    [
      'a Super Admin, another Super Admin',
      superAdmin(ORG_A),
      person({ id: '10000000-0000-0000-0000-00000000000f', role: Role.SUPER_ADMIN }),
      false,
    ],
    ['the Super Manager, Staff', superManager(ORG_A), people.staffA1, false],
    ['a Manager, their Staff', manager([DEPT_A1]), people.staffA1, false],
    ['Staff, themselves', staff(), people.staffA1, false],
  ])('%s: %s', (_who, me, target, allowed) => {
    expect(canSetGender(me, target)).toBe(allowed);
  });
});

describe('gender and the avatar in people answers', () => {
  it('an Admin sees the gender of their Staff, with the avatar', () => {
    expect(UserMapper.toPublic(maleOnM12(), admin())).toMatchObject({
      gender: 'MALE',
      avatarId: 'M12',
    });
    expect(UserMapper.toListItem(maleOnM12(), undefined, new Date(), admin())).toMatchObject({
      gender: 'MALE',
      avatarId: 'M12',
    });
  });

  it('says null to someone who may set it while it is not set', () => {
    expect(UserMapper.toPublic(person(), superAdmin(ORG_A))).toMatchObject({
      gender: null,
      avatarId: null,
    });
  });

  it.each<[string, AuthenticatedUser | undefined]>([
    ['the Super Manager', superManager(ORG_A)],
    ['a Manager', manager([DEPT_A1])],
    ['the person (Staff)', staff()],
    ['an Admin of another organisation', admin(ORG_B)],
    ['nobody named', undefined],
  ])('is never in an answer to %s; the avatar is', (_who, viewer) => {
    const one = UserMapper.toPublic(maleOnM12(), viewer);
    const row = UserMapper.toListItem(maleOnM12(), undefined, new Date(), viewer);
    expect(one).not.toHaveProperty('gender');
    expect(row).not.toHaveProperty('gender');
    expect(one.avatarId).toBe('M12');
    expect(row.avatarId).toBe('M12');
    expect(UserMapper.toBrief(maleOnM12()).avatarId).toBe('M12');
  });

  it('shows the default for the gender when nothing was chosen', () => {
    expect(UserMapper.toPublic(person({ gender: 'FEMALE' })).avatarId).toBe('F01');
  });

  it('the profile answers by who is asking', async () => {
    const users = { findById: jest.fn().mockResolvedValue(maleOnM12()) };
    const useCase = new GetProfileUseCase(users as never);
    await expect(useCase.execute(admin(), IDS.staffA1)).resolves.toHaveProperty('gender', 'MALE');
    await expect(useCase.execute(superManager(ORG_A), IDS.staffA1)).resolves.not.toHaveProperty(
      'gender',
    );
    const brief = await useCase.execute(manager([DEPT_A1]), IDS.staffA1);
    expect(brief).not.toHaveProperty('gender');
    expect(brief).toHaveProperty('avatarId', 'M12');
  });
});

describe('adding someone', () => {
  const row = {
    email: 'new@acme.test',
    firstName: 'New',
    lastName: 'Person',
    password: PASSWORD,
    role: 'USER',
    departmentId: DEPT_A1,
  };

  function setup(existing: User[] = []) {
    const users = {
      findByEmail: jest.fn(
        async (email: string) => existing.find((u) => u.email === email) ?? null,
      ),
      findById: jest.fn(),
      create: jest.fn(async (data: { gender?: 'MALE' | 'FEMALE' }) =>
        person({ id: '40000000-0000-0000-0000-000000000001', gender: data.gender ?? null }),
      ),
      save: jest.fn(async (u: User) => u),
    };
    const shifts = { findById: jest.fn(), companyExists: jest.fn() };
    const hasher = { hash: jest.fn(async () => 'hashed'), compare: jest.fn() };
    const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const audit = { record: jest.fn() };
    const useCase = new CreateUsersUseCase(
      users as never,
      shifts as never,
      fakeDepartments(),
      hasher,
      events,
      audit as never,
    );
    return { useCase, users, events };
  }

  it.each<[string, AuthenticatedUser]>([
    ['an Admin', admin()],
    ['a Super Admin in the organisation', superAdmin(ORG_A)],
  ])('%s sets it and gets the default avatar back', async (_who, me) => {
    const { useCase, users } = setup();
    const result = await useCase.execute(me, [{ ...row, gender: 'FEMALE' }], true);
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ gender: 'FEMALE' }));
    expect(result.created[0]).toMatchObject({ gender: 'FEMALE', avatarId: 'F01' });
  });

  it('stays optional: no gender, no avatar', async () => {
    const { useCase, users } = setup();
    const result = await useCase.execute(admin(), [row], true);
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ gender: undefined }));
    expect(result.created[0]).toMatchObject({ gender: null, avatarId: null });
  });

  it('refuses the Super Manager sending one, and adds nobody', async () => {
    const { useCase, users } = setup();
    await expect(
      useCase.execute(superManager(ORG_A), [{ ...row, gender: 'MALE' }]),
    ).rejects.toMatchObject({ status: 403, code: 'GENDER_FORBIDDEN' });
    expect(users.create).not.toHaveBeenCalled();
  });

  it('the Super Manager adding Staff without one is fine, and sees none back', async () => {
    const { useCase } = setup();
    const result = await useCase.execute(superManager(ORG_A), [row], true);
    expect(result.created[0]).not.toHaveProperty('gender');
  });

  it('bringing someone back with another gender resets their avatar and says so', async () => {
    const disabled = person({
      email: 'new@acme.test',
      status: 'DISABLED',
      gender: 'MALE',
      avatarId: 'M12',
    });
    const { useCase, events } = setup([disabled]);
    const result = await useCase.execute(admin(), [{ ...row, gender: 'FEMALE' }], true);
    expect(result.created[0]).toMatchObject({ gender: 'FEMALE', avatarId: 'F01' });
    expect(events.publish).toHaveBeenCalledWith(
      AvatarChangedEvent.eventName,
      new AvatarChangedEvent(IDS.staffA1, 'F01', ORG_A),
    );
  });

  it('bringing someone back with no gender before says so too', async () => {
    const disabled = person({ email: 'new@acme.test', status: 'DISABLED' });
    const { useCase, events } = setup([disabled]);
    await useCase.execute(admin(), [{ ...row, gender: 'MALE' }], true);
    expect(events.publish).toHaveBeenCalledWith(
      AvatarChangedEvent.eventName,
      new AvatarChangedEvent(IDS.staffA1, 'M01', ORG_A),
    );
  });

  it('bringing someone back with the same gender keeps the choice and says nothing', async () => {
    const disabled = maleOnM12({ email: 'new@acme.test', status: 'DISABLED' });
    const { useCase, events } = setup([disabled]);
    const result = await useCase.execute(admin(), [{ ...row, gender: 'MALE' }], true);
    expect(result.created[0]).toMatchObject({ gender: 'MALE', avatarId: 'M12' });
    expect(events.publish).not.toHaveBeenCalledWith(
      AvatarChangedEvent.eventName,
      expect.anything(),
    );
  });
});

describe('editing someone', () => {
  function setup(extra: User[] = []) {
    const people = cast();
    const users = fakeUsers([...Object.values(people), ...extra]);
    const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const audit = { record: jest.fn(), recordMany: jest.fn() };
    const useCase = new UpdateUserUseCase(
      users as never,
      fakeDepartments(),
      events as never,
      audit as never,
    );
    return { useCase, users, events };
  }
  const staffOnM12 = () => maleOnM12({ id: IDS.staffA1 });

  it('an Admin changing it resets the avatar to the new default and says so', async () => {
    const { useCase, users, events } = setup([staffOnM12()]);
    const saved = await useCase.execute(admin(), IDS.staffA1, { gender: 'FEMALE' });
    expect(saved).toMatchObject({ gender: 'FEMALE', avatarId: 'F01' });
    expect(users.save.mock.calls[0][0].avatarId).toBeNull();
    expect(events.publish).toHaveBeenCalledWith(
      AvatarChangedEvent.eventName,
      new AvatarChangedEvent(IDS.staffA1, 'F01', ORG_A),
    );
  });

  it('the same gender keeps the choice and says nothing', async () => {
    const { useCase, events } = setup([staffOnM12()]);
    const saved = await useCase.execute(admin(), IDS.staffA1, { gender: 'MALE' });
    expect(saved.avatarId).toBe('M12');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it("a Super Admin in the organisation sets an Admin's", async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.adminA, { gender: 'MALE' }),
    ).resolves.toMatchObject({ gender: 'MALE', avatarId: 'M01' });
  });

  it('a Super Admin sets their own (nobody else can), with a new name at once', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(superAdmin(null), IDS.superAdmin, { gender: 'FEMALE', firstName: 'Asha' }),
    ).resolves.toMatchObject({ gender: 'FEMALE', avatarId: 'F01', firstName: 'Asha' });
  });

  it.each<[string, AuthenticatedUser, string]>([
    ['an Admin, themselves', admin(), IDS.adminA],
    ['Staff, themselves', staff(), IDS.staffA1],
    ['the Super Manager, Staff', superManager(ORG_A), IDS.staffA1],
  ])('refuses %s (403 GENDER_FORBIDDEN)', async (_who, me, target) => {
    const { useCase, users } = setup();
    await expect(useCase.execute(me, target, { gender: 'MALE' })).rejects.toMatchObject({
      status: 403,
      code: 'GENDER_FORBIDDEN',
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('a Manager is refused as for any edit; another organisation is unknown', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA1, { gender: 'MALE' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      useCase.execute(admin(ORG_B), IDS.staffA1, { gender: 'MALE' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the people filter', () => {
  const users = { findAll: jest.fn(), count: jest.fn() };
  const presence = { presenceFor: jest.fn() };
  const useCase = new ListUsersUseCase(users as never, presence as never);

  beforeEach(() => {
    jest.resetAllMocks();
    users.findAll.mockResolvedValue([]);
    users.count.mockResolvedValue(0);
    presence.presenceFor.mockResolvedValue(new Map());
  });

  it.each([
    ['MALE', 'MALE'],
    ['FEMALE', 'FEMALE'],
    ['UNSET', null],
  ] as const)('%s filters on the column, inside the caller scope', async (asked, column) => {
    await useCase.execute(admin(), { gender: asked });
    expect(users.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ gender: column, companyId: ORG_A }),
    );
    expect(users.count).toHaveBeenCalledWith(expect.objectContaining({ gender: column }));
  });

  it('without it, every gender', async () => {
    await useCase.execute(admin(), {});
    expect(users.findAll.mock.calls[0][0]).not.toHaveProperty('gender');
  });

  it.each<[string, AuthenticatedUser]>([
    ['the Super Manager', superManager(ORG_A)],
    ['a Manager', manager([DEPT_A1])],
    ['Staff', staff()],
  ])('refuses %s', async (_who, me) => {
    await expect(useCase.execute(me, { gender: 'UNSET' })).rejects.toMatchObject({
      status: 403,
      code: 'GENDER_FORBIDDEN',
    });
    expect(users.findAll).not.toHaveBeenCalled();
  });

  it('answers by who is asking', async () => {
    users.findAll.mockResolvedValue([person({ gender: 'MALE' })]);
    const forAdmin = await useCase.execute(admin(), {});
    expect(forAdmin.users[0]).toMatchObject({ gender: 'MALE', avatarId: 'M01' });
    const forSuperManager = await useCase.execute(superManager(ORG_A), {});
    expect(forSuperManager.users[0]).not.toHaveProperty('gender');
    expect(forSuperManager.users[0].avatarId).toBe('M01');
  });
});
