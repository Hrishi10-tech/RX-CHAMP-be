// Unit test for CreateCompanyUseCase (4.0: an alias of POST /organisations). The
// organisation is created through OrganisationsService (name rules, Super Admin
// only); managerIds put people with no organisation into it, and anyone who cannot
// be put there is reported per id instead of failing the whole call.
import { ConflictError } from '@shared/exceptions/app.exception';
import { superAdmin } from '@shared/testing/actors.testing-spec';
import { CreateCompanyUseCase } from './create-company.use-case';

describe('CreateCompanyUseCase (alias of POST /organisations)', () => {
  const organisations = { create: jest.fn(), assignPerson: jest.fn() } as any;
  const me = superAdmin();
  const created = { id: 'c-1', name: 'lakshmangroup', createdAt: '2026-10-19T00:00:00.000Z' };

  let useCase: CreateCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new CreateCompanyUseCase(organisations);
    organisations.create.mockResolvedValue(created);
  });

  it('passes a duplicate-name refusal through', async () => {
    organisations.create.mockRejectedValue(new ConflictError('exists', 'ORG_EXISTS'));
    await expect(useCase.execute({ name: 'dup' }, me)).rejects.toBeInstanceOf(ConflictError);
    expect(organisations.assignPerson).not.toHaveBeenCalled();
  });

  it('creates an empty organisation when no managerIds are given', async () => {
    const result = await useCase.execute({ name: 'lakshmangroup' }, me);
    expect(organisations.create).toHaveBeenCalledWith(me, 'lakshmangroup');
    expect(result).toEqual({ ...created, assignments: { assigned: [], errors: [] } });
  });

  it('assigns each person once and reports those it could not', async () => {
    organisations.assignPerson.mockImplementation(
      async (_me: unknown, _org: string, id: string) => {
        if (id === 'ghost') throw new Error('Unknown person');
        return { id, companyId: 'c-1', role: 'MANAGER', changed: true };
      },
    );
    const result = await useCase.execute(
      { name: 'lakshmangroup', managerIds: ['mgr-1', 'ghost', 'mgr-1'] },
      me,
    );
    expect(organisations.assignPerson).toHaveBeenCalledTimes(2);
    expect(result.assignments).toEqual({
      assigned: ['mgr-1'],
      errors: [{ managerId: 'ghost', error: 'Unknown person' }],
    });
  });
});
