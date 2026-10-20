import { Role } from '@shared/rbac/roles.enum';
import {
  DEPT_A1,
  DEPT_A2,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { contactsWhere, relationOf } from './prisma-chat-contacts.reader';

/** The 4.0 messages matrix (docs/4.0/SPEC.md 1.2), as Prisma filters. */
describe('chat contacts scope', () => {
  it('Admin: everyone in their organisation, and the Super Admins', () => {
    expect(contactsWhere(admin(ORG_A))).toEqual({
      OR: [
        { companyId: ORG_A, role: { name: { not: 'SUPER_ADMIN' } } },
        { role: { name: 'SUPER_ADMIN' } },
      ],
    });
  });

  it("Manager: their departments' Staff and the organisation Admin", () => {
    expect(contactsWhere(manager([DEPT_A1, DEPT_A2]))).toEqual({
      OR: [
        { companyId: ORG_A, role: { name: 'ADMIN' } },
        { companyId: ORG_A, role: { name: 'USER' }, departmentId: { in: [DEPT_A1, DEPT_A2] } },
      ],
    });
    // No departments: the Admin only, never everyone.
    expect(contactsWhere(manager([]))).toEqual({
      OR: [{ companyId: ORG_A, role: { name: 'ADMIN' } }],
    });
  });

  it("Staff: their department's managers and the organisation Admin", () => {
    expect(contactsWhere(staff(DEPT_A2))).toEqual({
      OR: [
        { companyId: ORG_A, role: { name: 'ADMIN' } },
        {
          companyId: ORG_A,
          role: { name: 'MANAGER' },
          managedDepartments: { some: { departmentId: DEPT_A2, department: { deletedAt: null } } },
        },
      ],
    });
  });

  it('Super Admin: the Admin of the selected organisation; nobody without one', () => {
    expect(contactsWhere(superAdmin(ORG_B))).toEqual({ companyId: ORG_B, role: { name: 'ADMIN' } });
    expect(contactsWhere(superAdmin(null))).toBeNull();
  });

  it('labels who is above and below', () => {
    expect(relationOf(Role.USER, 'MANAGER')).toBe('MANAGER');
    expect(relationOf(Role.USER, 'ADMIN')).toBe('ORG');
    expect(relationOf(Role.MANAGER, 'USER')).toBe('REPORT');
    expect(relationOf(Role.MANAGER, 'ADMIN')).toBe('MANAGER');
    expect(relationOf(Role.ADMIN, 'SUPER_ADMIN')).toBe('MANAGER');
    expect(relationOf(Role.ADMIN, 'USER')).toBe('REPORT');
    expect(relationOf(Role.SUPER_ADMIN, 'ADMIN')).toBe('REPORT');
  });
});
