// Unit test for UpdateCompanyUseCase — unknown company, the name-clash guard, and
// that saving a company under its own name is allowed rather than a self-conflict.
import { ConflictError, NotFoundError } from '@shared/exceptions/app.exception';
import { UpdateCompanyUseCase } from './update-company.use-case';

describe('UpdateCompanyUseCase', () => {
  const companies = { findById: jest.fn(), findByName: jest.fn(), rename: jest.fn() } as any;
  const existing = { id: 'c1', name: 'RHYTHMRX', createdAt: new Date('2026-08-10') };

  let useCase: UpdateCompanyUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new UpdateCompanyUseCase(companies);
  });

  it('rejects an unknown company', async () => {
    companies.findById.mockResolvedValue(null);

    await expect(useCase.execute('missing', { name: 'Anything' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(companies.rename).not.toHaveBeenCalled();
  });

  it('rejects a name another company already holds', async () => {
    companies.findById.mockResolvedValue(existing);
    companies.findByName.mockResolvedValue({ id: 'c2', name: 'A2C', createdAt: new Date() });

    await expect(useCase.execute('c1', { name: 'A2C' })).rejects.toBeInstanceOf(ConflictError);
    expect(companies.rename).not.toHaveBeenCalled();
  });

  it('allows a company to keep its own name', async () => {
    companies.findById.mockResolvedValue(existing);
    companies.findByName.mockResolvedValue(existing);
    companies.rename.mockResolvedValue(existing);

    await expect(useCase.execute('c1', { name: 'RHYTHMRX' })).resolves.toMatchObject({
      id: 'c1',
      name: 'RHYTHMRX',
    });
  });

  it('trims the name before saving', async () => {
    companies.findById.mockResolvedValue(existing);
    companies.findByName.mockResolvedValue(null);
    companies.rename.mockResolvedValue({ ...existing, name: 'Rhythm RX' });

    const result = await useCase.execute('c1', { name: '  Rhythm RX  ' });

    expect(companies.rename).toHaveBeenCalledWith('c1', 'Rhythm RX');
    expect(result.name).toBe('Rhythm RX');
  });
});
