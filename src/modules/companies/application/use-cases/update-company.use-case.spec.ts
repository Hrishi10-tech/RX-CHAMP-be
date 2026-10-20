// Unit test for UpdateCompanyUseCase (4.0: an alias of PATCH /organisations/:id).
import { ConflictError, NotFoundError } from '@shared/exceptions/app.exception';
import { superAdmin } from '@shared/testing/actors.testing-spec';
import { UpdateCompanyUseCase } from './update-company.use-case';

describe('UpdateCompanyUseCase (alias of PATCH /organisations/:id)', () => {
  const organisations = { rename: jest.fn() } as any;
  const me = superAdmin();

  let useCase: UpdateCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new UpdateCompanyUseCase(organisations);
  });

  it('renames through the organisations service', async () => {
    organisations.rename.mockResolvedValue({ id: 'c1', name: 'Rhythm RX', createdAt: 'x' });
    await expect(useCase.execute(me, 'c1', { name: '  Rhythm RX  ' })).resolves.toMatchObject({
      name: 'Rhythm RX',
    });
    expect(organisations.rename).toHaveBeenCalledWith(me, 'c1', '  Rhythm RX  ');
  });

  it('passes unknown-organisation and clash refusals through', async () => {
    organisations.rename.mockRejectedValueOnce(
      new NotFoundError('That organisation does not exist.'),
    );
    await expect(useCase.execute(me, 'missing', { name: 'Anything' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    organisations.rename.mockRejectedValueOnce(new ConflictError('exists', 'ORG_EXISTS'));
    await expect(useCase.execute(me, 'c1', { name: 'A2C' })).rejects.toBeInstanceOf(ConflictError);
  });
});
