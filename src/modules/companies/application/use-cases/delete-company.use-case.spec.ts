// Unit test for DeleteCompanyUseCase (4.0: an alias of DELETE /organisations/:id).
// An organisation with active people is refused (409 ORG_NOT_EMPTY) rather than
// deleted with them; the result shape of 3.x is kept.
import { ConflictError, NotFoundError } from '@shared/exceptions/app.exception';
import { superAdmin } from '@shared/testing/actors.testing-spec';
import { DeleteCompanyUseCase } from './delete-company.use-case';

describe('DeleteCompanyUseCase (alias of DELETE /organisations/:id)', () => {
  const organisations = { remove: jest.fn() } as any;
  const me = superAdmin();

  let useCase: DeleteCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new DeleteCompanyUseCase(organisations);
  });

  it('rejects an unknown organisation', async () => {
    organisations.remove.mockRejectedValue(new NotFoundError('missing'));
    await expect(useCase.execute(me, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses while active people remain', async () => {
    organisations.remove.mockRejectedValue(new ConflictError('still has people', 'ORG_NOT_EMPTY'));
    await expect(useCase.execute(me, 'c2')).rejects.toMatchObject({ code: 'ORG_NOT_EMPTY' });
  });

  it('reports what was removed', async () => {
    organisations.remove.mockResolvedValue({
      deleted: true,
      id: 'c1',
      name: 'xelements',
      membersRemoved: 2,
    });
    await expect(useCase.execute(me, 'c1')).resolves.toEqual({
      deleted: true,
      id: 'c1',
      name: 'xelements',
      membersRemoved: 2,
    });
    expect(organisations.remove).toHaveBeenCalledWith(me, 'c1');
  });
});
