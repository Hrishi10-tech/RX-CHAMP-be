// Unit test for DeleteCompanyUseCase — unknown company is rejected, and a delete
// reports how many members went with it so the caller can say what happened.
import { NotFoundError } from '@shared/exceptions/app.exception';
import { DeleteCompanyUseCase } from './delete-company.use-case';

describe('DeleteCompanyUseCase', () => {
  const companies = { findById: jest.fn(), softDelete: jest.fn() } as any;

  let useCase: DeleteCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new DeleteCompanyUseCase(companies);
  });

  it('rejects an unknown company without deleting anything', async () => {
    companies.findById.mockResolvedValue(null);

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(companies.softDelete).not.toHaveBeenCalled();
  });

  it('deletes an empty company and reports no members removed', async () => {
    companies.findById.mockResolvedValue({ id: 'c1', name: 'xelements', createdAt: new Date() });
    companies.softDelete.mockResolvedValue(0);

    await expect(useCase.execute('c1')).resolves.toEqual({
      deleted: true,
      id: 'c1',
      name: 'xelements',
      membersRemoved: 0,
    });
    expect(companies.softDelete).toHaveBeenCalledWith('c1');
  });

  it('reports the members that went with a populated company', async () => {
    companies.findById.mockResolvedValue({ id: 'c2', name: 'RHYTHMRX', createdAt: new Date() });
    companies.softDelete.mockResolvedValue(12);

    const result = await useCase.execute('c2');

    expect(result.membersRemoved).toBe(12);
    expect(result.name).toBe('RHYTHMRX');
  });
});
