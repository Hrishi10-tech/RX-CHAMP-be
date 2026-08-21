import { Role } from '@shared/rbac/roles.enum';
import { InvalidUserState } from '@shared/exceptions/domain.exception';
import { User } from './user.entity';
import { Email } from '../value-objects/email.vo';
import { UserId } from '../value-objects/user-id.vo';

function makeUser(overrides: Partial<Parameters<typeof User.fromPersistence>[0]> = {}): User {
  return User.fromPersistence({
    id: UserId.create('u-1'),
    email: Email.create('jane@acme.test'),
    passwordHash: 'hash',
    firstName: 'Jane',
    lastName: 'Doe',
    designation: null,
    role: Role.USER,
    department: 'Eng',
    managerId: 'm-1',
    companyId: null,
    companyName: null,
    shiftId: null,
    shiftStart: '10:00',
    shiftEnd: '19:00',
    status: 'ACTIVE',
    screenshotsEnabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

describe('User entity', () => {
  it('builds the cached display name from first + last', () => {
    expect(makeUser().name).toBe('Jane Doe');
  });

  it('reports role helpers correctly', () => {
    expect(makeUser({ role: Role.SUPER_ADMIN }).isAdmin()).toBe(true);
    expect(makeUser({ role: Role.MANAGER }).isManager()).toBe(true);
    expect(makeUser({ role: Role.USER }).isPlainUser()).toBe(true);
  });

  it('changes status and reflects isActive()', () => {
    const u = makeUser();
    u.changeStatus('DISABLED');
    expect(u.status).toBe('DISABLED');
    expect(u.isActive()).toBe(false);
  });

  it('rejects an invalid status', () => {
    // @ts-expect-error testing the guard
    expect(() => makeUser().changeStatus('NOPE')).toThrow(InvalidUserState);
  });

  it('reactivates a disabled account and refreshes details', () => {
    const u = makeUser({ status: 'DISABLED' });
    u.reactivateWith('Janet', 'Doe', 'Engineer');
    expect(u.status).toBe('ACTIVE');
    expect(u.firstName).toBe('Janet');
    expect(u.designation).toBe('Engineer');
  });
});

describe('Email value object', () => {
  it('lowercases + trims', () => {
    expect(Email.create('  Jane@Acme.TEST ').value).toBe('jane@acme.test');
  });

  it('rejects invalid input', () => {
    expect(() => Email.create('not-an-email')).toThrow();
  });
});
