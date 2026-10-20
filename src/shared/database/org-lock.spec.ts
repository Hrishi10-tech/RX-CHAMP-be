import { Role } from '@shared/rbac/roles.enum';
import { PostgresUserRepository } from '@modules/users/infrastructure/repositories/postgres-user.repository';
import { lockOrganisation } from './org-lock';

/**
 * 4.0 (audit L4): deleting an organisation and adding to it are ordered by the
 * organisation's row lock, and a deleted organisation takes nobody new.
 */
describe('lockOrganisation', () => {
  it('locks the live row FOR UPDATE and says whether there is one', async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'c1' }])
        .mockResolvedValueOnce([]),
    };
    expect(await lockOrganisation(tx as never, 'c1')).toBe(true);
    const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toMatch(/FROM companies/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(await lockOrganisation(tx as never, 'c1')).toBe(false);
  });
});

describe('PostgresUserRepository.create under the organisation lock', () => {
  function setup(orgRows: unknown[]) {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(async () => {
        order.push('lock');
        return orgRows;
      }),
      user: {
        create: jest.fn(async () => {
          order.push('create');
          return { id: 'u1', companyId: 'c1' };
        }),
        findUniqueOrThrow: jest.fn(),
      },
      managerDepartment: { createMany: jest.fn() },
      shiftAssignment: { create: jest.fn() },
    };
    const prisma = {
      role: { findUniqueOrThrow: jest.fn(async () => ({ id: 'role-user' })) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const repo = new PostgresUserRepository(prisma as never);
    const data = {
      email: 'new@x.test',
      passwordHash: 'h',
      firstName: 'New',
      lastName: 'Person',
      role: Role.USER,
      companyId: 'c1',
      departmentId: 'd1',
      createdById: 'admin',
    };
    return { repo, tx, order, data };
  }

  it('a deleted (or deleting) organisation takes nobody new: 404 ORG_NOT_FOUND, nothing written', async () => {
    const { repo, tx, data } = setup([]);
    await expect(repo.create(data as never)).rejects.toMatchObject({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('a live organisation is locked before the person is written', async () => {
    const { repo, tx, order, data } = setup([{ id: 'c1' }]);
    tx.user.findUniqueOrThrow.mockRejectedValueOnce(new Error('stop after the insert'));
    await expect(repo.create(data as never)).rejects.toThrow('stop after the insert');
    expect(order).toEqual(['lock', 'create']);
  });
});
