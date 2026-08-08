// Unit test for CreateCompanyUseCase — duplicate guard, optional manager
// assignment (links companyId + publishes CompanyAssignedEvent), and partial
// failure reporting for unknown manager ids.
import { Role } from '@shared/rbac/roles.enum';
import { ConflictError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';
import { CreateCompanyUseCase } from './create-company.use-case';

function buildManager(id: string): User {
  return User.fromPersistence({
    id: UserId.create(id),
    email: Email.create(`${id}@timechamp.test`),
    passwordHash: 'hash',
    firstName: 'Mary',
    lastName: 'Manager',
    designation: null,
    role: Role.MANAGER,
    department: null,
    managerId: null,
    companyId: null,
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status: 'ACTIVE',
    createdAt: new Date(),
  });
}

describe('CreateCompanyUseCase', () => {
  const companies = { findByName: jest.fn(), create: jest.fn() } as any;
  const users = { findById: jest.fn(), save: jest.fn() } as any;
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const me = { id: 'super-1', role: Role.SUPER_ADMIN } as AuthenticatedUser;

  let useCase: CreateCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new CreateCompanyUseCase(companies, users, events);
    users.save.mockImplementation(async (u: User) => u);
  });

  it('rejects a duplicate name', async () => {
    companies.findByName.mockResolvedValue({ id: 'c-0', name: 'dup', createdAt: new Date() });
    await expect(useCase.execute({ name: 'dup' }, me)).rejects.toBeInstanceOf(ConflictError);
    expect(companies.create).not.toHaveBeenCalled();
  });

  it('creates an unassigned company when no managerIds are given', async () => {
    companies.findByName.mockResolvedValue(null);
    companies.create.mockResolvedValue({ id: 'c-1', name: 'lakshmangroup', createdAt: new Date() });

    const result = await useCase.execute({ name: 'lakshmangroup' }, me);

    expect(result.id).toBe('c-1');
    expect(result.assignments).toEqual({ assigned: [], errors: [] });
    expect(users.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('assigns provided managers to the new company and notifies them', async () => {
    companies.findByName.mockResolvedValue(null);
    companies.create.mockResolvedValue({ id: 'c-1', name: 'lakshmangroup', createdAt: new Date() });
    const mgr = buildManager('mgr-1');
    users.findById.mockImplementation(async (id: string) => (id === 'mgr-1' ? mgr : null));

    const result = await useCase.execute(
      { name: 'lakshmangroup', managerIds: ['mgr-1', 'ghost'] },
      me,
    );

    expect(mgr.companyId).toBe('c-1');
    expect(result.assignments.assigned).toEqual(['mgr-1']);
    expect(result.assignments.errors).toEqual([{ managerId: 'ghost', error: 'unknown user' }]);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith(
      CompanyAssignedEvent.eventName,
      expect.objectContaining({ userId: 'mgr-1', companyId: 'c-1', companyName: 'lakshmangroup' }),
    );
  });
});
