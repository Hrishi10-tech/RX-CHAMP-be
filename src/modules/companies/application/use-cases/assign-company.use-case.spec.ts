// Unit test for AssignCompanyUseCase (4.0 alias): only people with no organisation
// can be put into one; the answer is the person as /users shows them.
import { Role } from '@shared/rbac/roles.enum';
import { ConflictError, NotFoundError } from '@shared/exceptions/app.exception';
import { superAdmin } from '@shared/testing/actors.testing-spec';
import { User } from '@modules/users/domain/entities/user.entity';
import { Email } from '@modules/users/domain/value-objects/email.vo';
import { UserId } from '@modules/users/domain/value-objects/user-id.vo';
import { AssignCompanyUseCase } from './assign-company.use-case';

function buildManager(companyId: string | null): User {
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
    companyId,
    companyName: null,
    shiftId: null,
    shiftStart: null,
    shiftEnd: null,
    status: 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: null,
    createdAt: new Date(),
  });
}

describe('AssignCompanyUseCase (alias)', () => {
  const organisations = { assignPerson: jest.fn() } as any;
  const users = { findById: jest.fn() } as any;
  const me = superAdmin();

  let useCase: AssignCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new AssignCompanyUseCase(organisations, users);
  });

  it('passes refusals through (unknown organisation, someone in another one)', async () => {
    organisations.assignPerson.mockRejectedValueOnce(
      new NotFoundError('That organisation does not exist.'),
    );
    await expect(useCase.execute(me, 'c-x', 'mgr-1')).rejects.toBeInstanceOf(NotFoundError);
    organisations.assignPerson.mockRejectedValueOnce(
      new ConflictError('moving', 'PERSON_IN_ORGANISATION'),
    );
    await expect(useCase.execute(me, 'c-1', 'mgr-1')).rejects.toMatchObject({
      code: 'PERSON_IN_ORGANISATION',
    });
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('answers the person in their new organisation', async () => {
    organisations.assignPerson.mockResolvedValue({
      id: 'mgr-1',
      companyId: 'c-1',
      role: 'MANAGER',
      changed: true,
    });
    users.findById.mockResolvedValue(buildManager('c-1'));
    const result = await useCase.execute(me, 'c-1', 'mgr-1');
    expect(organisations.assignPerson).toHaveBeenCalledWith(me, 'c-1', 'mgr-1');
    expect(result).toMatchObject({ id: 'mgr-1', companyId: 'c-1', role: Role.MANAGER });
  });
});
