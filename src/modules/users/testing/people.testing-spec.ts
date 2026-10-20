/**
 * People (User entities) for the users module's tests. Not a test itself and not
 * part of the build (see shared/testing/actors.testing-spec.ts).
 */
import { Role } from '@shared/rbac/roles.enum';
import { UserStatus } from '@shared/types/user.types';
import { DEPT_A1, DEPT_A2, DEPT_B1, IDS, ORG_A, ORG_B } from '@shared/testing/actors.testing-spec';
import { DepartmentRef, User } from '../domain/entities/user.entity';
import { Email } from '../domain/value-objects/email.vo';
import { UserId } from '../domain/value-objects/user-id.vo';

export const DEPTS: Record<string, DepartmentRef> = {
  [DEPT_A1]: { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board' },
  [DEPT_A2]: { id: DEPT_A2, name: 'Sales', icon: 'bar-chart' },
  [DEPT_B1]: { id: DEPT_B1, name: 'Support', icon: 'headphones' },
};

export const DEPT_ORG: Record<string, string> = {
  [DEPT_A1]: ORG_A,
  [DEPT_A2]: ORG_A,
  [DEPT_B1]: ORG_B,
};

/** A department reader over DEPTS: only the organisation's departments are found. */
export function fakeDepartments() {
  return {
    findInOrg: jest.fn(async (companyId: string, ids: string[]) =>
      [...new Set(ids)].filter((id) => DEPT_ORG[id] === companyId).map((id) => DEPTS[id]),
    ),
  };
}

export interface PersonOver {
  id?: string;
  email?: string;
  role?: Role;
  companyId?: string | null;
  departmentId?: string | null;
  managed?: string[];
  status?: UserStatus;
  grants?: { screenshots: boolean; timeline: boolean; activity: boolean };
}

export function person(over: PersonOver = {}): User {
  const departmentId = over.departmentId === undefined ? DEPT_A1 : over.departmentId;
  const role = over.role ?? Role.USER;
  return User.fromPersistence({
    id: UserId.create(over.id ?? IDS.staffA1),
    email: Email.create(over.email ?? `${(over.id ?? IDS.staffA1).slice(-6)}@acme.test`),
    passwordHash: 'hash',
    firstName: 'Jane',
    lastName: 'Doe',
    designation: null,
    role,
    department: departmentId ? (DEPTS[departmentId]?.name ?? null) : null,
    managerId: null,
    companyId: over.companyId === undefined ? ORG_A : over.companyId,
    companyName: null,
    shiftId: null,
    shiftStart: '10:00',
    shiftEnd: '19:00',
    status: over.status ?? 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    departmentId,
    departmentRef: departmentId ? (DEPTS[departmentId] ?? null) : null,
    managedDepartments: (over.managed ?? []).map((id) => DEPTS[id]),
    grantScreenshots: over.grants?.screenshots ?? false,
    grantTimeline: over.grants?.timeline ?? false,
    grantActivity: over.grants?.activity ?? false,
  });
}

/** The standing cast: Admin and Staff of both organisations and a Manager of A1. */
export function cast() {
  return {
    adminA: person({ id: IDS.adminA, role: Role.ADMIN, departmentId: null }),
    adminB: person({ id: IDS.adminB, role: Role.ADMIN, companyId: ORG_B, departmentId: null }),
    managerA1: person({ id: IDS.managerA1, role: Role.MANAGER, managed: [DEPT_A1] }),
    staffA1: person({ id: IDS.staffA1 }),
    staffA2: person({ id: IDS.staffA2, departmentId: DEPT_A2 }),
    staffB1: person({ id: IDS.staffB1, companyId: ORG_B, departmentId: DEPT_B1 }),
    superAdmin: person({
      id: IDS.superAdmin,
      role: Role.SUPER_ADMIN,
      companyId: null,
      departmentId: null,
    }),
  };
}

/** A repository over these people (findById/findByEmail/save/create/count). */
export function fakeUsers(people: User[]) {
  const byId = new Map(people.map((p) => [p.id, p] as const));
  return {
    findById: jest.fn(async (id: string) => byId.get(id) ?? null),
    findByEmail: jest.fn(
      async (email: string) => [...byId.values()].find((p) => p.email === email) ?? null,
    ),
    save: jest.fn(async (u: User) => {
      u.markSaved();
      return u;
    }),
    create: jest.fn(),
    count: jest.fn(async () => 5),
    findAll: jest.fn(async () => []),
    softDelete: jest.fn(),
    bumpEnrollVersion: jest.fn(async () => 2),
  };
}
