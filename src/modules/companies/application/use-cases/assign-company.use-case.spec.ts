import { Role } from '@shared/rbac/roles.enum';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';
import { AssignCompanyUseCase } from './assign-company.use-case';

function buildManager(): User {
  return User.fromPersistence({
    id: UserId.create('mgr-1'),
    email: Email.create('manager@timechamp.test'),
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

describe('AssignCompanyUseCase', () => {
  const companies = { findById: jest.fn() } as any;
  const users = { findById: jest.fn(), save: jest.fn() } as any;
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const me = { id: 'super-1', role: Role.SUPER_ADMIN } as AuthenticatedUser;

  let useCase: AssignCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new AssignCompanyUseCase(companies, users, events);
  });

  it('rejects an unknown company', async () => {
    companies.findById.mockResolvedValue(null);
    await expect(useCase.execute(me, 'c-x', 'mgr-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects an unknown user', async () => {
    companies.findById.mockResolvedValue({ id: 'c-1', name: 'Acme', createdAt: new Date() });
    users.findById.mockResolvedValue(null);
    await expect(useCase.execute(me, 'c-1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('links the user to the company and publishes CompanyAssignedEvent', async () => {
    const manager = buildManager();
    companies.findById.mockResolvedValue({ id: 'c-1', name: 'Acme', createdAt: new Date() });
    users.findById.mockResolvedValue(manager);
    users.save.mockImplementation(async (u: User) => u);

    const result = await useCase.execute(me, 'c-1', 'mgr-1');

    expect(manager.companyId).toBe('c-1');
    expect(result.companyId).toBe('c-1');
    expect(users.save).toHaveBeenCalledWith(manager);
    expect(events.publish).toHaveBeenCalledWith(
      CompanyAssignedEvent.eventName,
      expect.objectContaining({
        userId: 'mgr-1',
        userRole: Role.MANAGER,
        companyId: 'c-1',
        companyName: 'Acme',
        assignedByUserId: 'super-1',
      }),
    );
  });
});
