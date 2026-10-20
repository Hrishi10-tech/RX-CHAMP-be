import {
  DEPT_A1,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { GetMeUseCase, permissionsOf } from './get-me.use-case';

describe('GET /me permissions', () => {
  it('Super Admin on the platform view: organisations only', () => {
    expect(permissionsOf(superAdmin(null))).toMatchObject({
      canManageOrganisations: true,
      canManageOrg: false,
      canManagePeople: false,
      canSeeTeam: false,
      needsOrganisation: true,
      canUsePortal: true,
    });
  });

  it('Super Admin inside an organisation, and Admin: everything in it', () => {
    for (const me of [superAdmin(ORG_A), admin(ORG_A)]) {
      expect(permissionsOf(me)).toMatchObject({
        canManageOrg: true,
        canManagePeople: true,
        canManageDepartments: true,
        canManageShifts: true,
        canSeeTeam: true,
        canSeeScreenshots: true,
        canSeeTimeline: true,
        canSeeActivity: true,
        canApprove: true,
        needsOrganisation: false,
      });
    }
    expect(permissionsOf(admin(ORG_A)).canManageOrganisations).toBe(false);
  });

  it('Manager: no people management; Team and sections only with grants', () => {
    expect(permissionsOf(manager([DEPT_A1]))).toMatchObject({
      canManagePeople: false,
      canManageOrg: false,
      canSeeTeam: false,
      canSeeScreenshots: false,
      canApprove: true,
      canSeeReports: true,
    });
    expect(permissionsOf(manager([DEPT_A1], { timeline: true }))).toMatchObject({
      canSeeTeam: true,
      canSeeTimeline: true,
      canSeeScreenshots: false,
      canSeeActivity: false,
    });
  });

  it('Staff: the agent only', () => {
    expect(permissionsOf(staff())).toMatchObject({
      canUsePortal: false,
      canSeeTeam: false,
      canApprove: false,
    });
  });
});

describe('GetMeUseCase', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'm@acme.test',
    firstName: 'Maya',
    lastName: 'K',
    role: { name: 'MANAGER' },
    company: { id: ORG_A, name: 'Xelements', deletedAt: null },
    departmentRef: { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board', deletedAt: null },
    managedDepartments: [
      { department: { id: 'd2', name: 'Sales', icon: 'bar-chart' } },
      { department: { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board' } },
    ],
    ...over,
  });

  it('answers the organisation, departments and grants in one query for most people', async () => {
    const prisma = {
      user: { findFirst: jest.fn(async () => row()) },
      company: { findFirst: jest.fn() },
    };
    const me = await new GetMeUseCase(prisma as any).execute(
      manager([DEPT_A1], { activity: true }),
    );
    expect(me).toMatchObject({
      name: 'Maya K',
      role: 'MANAGER',
      organisation: { id: ORG_A, name: 'Xelements' },
      department: { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board' },
      departments: [
        { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board' },
        { id: 'd2', name: 'Sales', icon: 'bar-chart' },
      ],
      grants: { screenshots: false, timeline: false, activity: true },
    });
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('a Super Admin gets the organisation chosen with X-Org-Id, or none', async () => {
    const saRow = row({
      role: { name: 'SUPER_ADMIN' },
      company: null,
      departmentRef: null,
      managedDepartments: [],
    });
    const prisma = {
      user: { findFirst: jest.fn(async () => saRow) },
      company: { findFirst: jest.fn(async () => ({ id: ORG_B, name: 'RhythmRx' })) },
    };
    const useCase = new GetMeUseCase(prisma as any);
    await expect(useCase.execute(superAdmin(ORG_B))).resolves.toMatchObject({
      organisation: { id: ORG_B, name: 'RhythmRx' },
      departments: [],
      permissions: { canManagePeople: true },
    });
    await expect(useCase.execute(superAdmin(null))).resolves.toMatchObject({
      organisation: null,
      grants: { screenshots: false, timeline: false, activity: false },
      permissions: { canManagePeople: false, needsOrganisation: true },
    });
  });
});
