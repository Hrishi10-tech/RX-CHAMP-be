import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser, NO_GRANTS, ViewGrants } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  agentHealthOrg,
  agentHealthPeopleWhere,
  assertCanSeeAgentHealth,
} from './agent-health.scope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const DEPT_1 = '33333333-3333-4333-8333-333333333333';
const DEPT_2 = '44444444-4444-4444-8444-444444444444';

function actor(role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const platform = role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER;
  const companyId = platform ? null : ORG_A;
  return {
    id: `${role.toLowerCase()}-me`,
    email: `${role.toLowerCase()}@a.test`,
    role,
    permissions: [],
    department: null,
    companyId,
    status: 'ACTIVE',
    orgId: companyId,
    departmentId: null,
    managedDepartmentIds: [],
    ...over,
  } as AuthenticatedUser;
}

const grants = (g: Partial<ViewGrants> = {}): ViewGrants => ({ ...NO_GRANTS, ...g });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppException ? e.code : 'OTHER';
  }
  return undefined;
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppException ? e.status : -1;
  }
  return undefined;
}

/** The list-level filter every row passes (active, never the overseers). */
const LISTED = {
  status: 'ACTIVE',
  role: { name: { notIn: [Role.SUPER_ADMIN, Role.SUPER_MANAGER] } },
};

describe('agent health scope (4.0)', () => {
  describe('who may open it', () => {
    it('lets Admins, Super Admins and the Super Manager in, with or without an organisation', () => {
      expect(() => assertCanSeeAgentHealth(actor(Role.ADMIN))).not.toThrow();
      expect(() => assertCanSeeAgentHealth(actor(Role.SUPER_ADMIN))).not.toThrow();
      expect(() => assertCanSeeAgentHealth(actor(Role.SUPER_MANAGER))).not.toThrow();
      expect(() =>
        assertCanSeeAgentHealth(actor(Role.SUPER_MANAGER, { orgId: ORG_B })),
      ).not.toThrow();
    });

    it('needs a view grant for a Manager, like every live-status view', () => {
      const bare = actor(Role.MANAGER, { managedDepartmentIds: [DEPT_1], grants: grants() });
      expect(codeOf(() => assertCanSeeAgentHealth(bare))).toBe('GRANT_REQUIRED');
      const granted = actor(Role.MANAGER, {
        managedDepartmentIds: [DEPT_1],
        grants: grants({ timeline: true }),
      });
      expect(() => assertCanSeeAgentHealth(granted)).not.toThrow();
    });

    it('keeps Staff out', () => {
      expect(statusOf(() => assertCanSeeAgentHealth(actor(Role.USER)))).toBe(403);
    });
  });

  describe('which people are listed', () => {
    it('Manager: Staff of their departments only', () => {
      const me = actor(Role.MANAGER, {
        managedDepartmentIds: [DEPT_1, DEPT_2],
        grants: grants({ screenshots: true }),
      });
      expect(agentHealthPeopleWhere(me, {})).toEqual({
        AND: [
          {
            AND: [
              { companyId: ORG_A, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null },
              { OR: [{ role: { name: Role.USER }, departmentId: { in: [DEPT_1, DEPT_2] } }] },
            ],
          },
          LISTED,
        ],
      });
    });

    it('Manager without departments: nobody', () => {
      const me = actor(Role.MANAGER, { grants: grants({ activity: true }) });
      const where = agentHealthPeopleWhere(me, {}) as { AND: Record<string, unknown>[] };
      expect(where.AND[0]).toMatchObject({ id: { in: [] } });
    });

    it('Manager: a department outside theirs is unknown (404)', () => {
      const me = actor(Role.MANAGER, {
        managedDepartmentIds: [DEPT_1],
        grants: grants({ activity: true }),
      });
      expect(statusOf(() => agentHealthPeopleWhere(me, { departmentId: DEPT_2 }))).toBe(404);
      const where = agentHealthPeopleWhere(me, { departmentId: DEPT_1 }) as {
        AND: Record<string, unknown>[];
      };
      expect(where.AND[2]).toEqual({ departmentId: DEPT_1 });
    });

    it('Admin: their organisation; another organisation named in the query is unknown', () => {
      const me = actor(Role.ADMIN);
      expect(agentHealthPeopleWhere(me, {})).toEqual({
        AND: [
          { companyId: ORG_A, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null },
          LISTED,
        ],
      });
      expect(agentHealthOrg(me, {})).toBe(ORG_A);
      expect(agentHealthOrg(me, { companyId: ORG_A })).toBe(ORG_A);
      expect(statusOf(() => agentHealthPeopleWhere(me, { companyId: ORG_B }))).toBe(404);
    });

    it.each([Role.SUPER_ADMIN, Role.SUPER_MANAGER])(
      '%s with "All organisations": everyone in every live organisation',
      (role) => {
        const me = actor(role);
        expect(agentHealthOrg(me, {})).toBeNull();
        expect(agentHealthPeopleWhere(me, {})).toEqual({
          AND: [
            {
              companyId: { not: null },
              company: { deletedAt: null },
              role: { name: { not: Role.SUPER_ADMIN } },
              deletedAt: null,
            },
            LISTED,
          ],
        });
      },
    );

    it.each([Role.SUPER_ADMIN, Role.SUPER_MANAGER])(
      '%s with an organisation picked (X-Org-Id): that organisation',
      (role) => {
        const me = actor(role, { orgId: ORG_B });
        expect(agentHealthOrg(me, {})).toBe(ORG_B);
        expect(agentHealthPeopleWhere(me, {})).toEqual({
          AND: [
            { companyId: ORG_B, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null },
            LISTED,
          ],
        });
      },
    );

    it('Super Manager: companyId in the query wins over the organisation in view', () => {
      const me = actor(Role.SUPER_MANAGER, { orgId: ORG_A });
      expect(agentHealthOrg(me, { companyId: ORG_B })).toBe(ORG_B);
      expect(agentHealthPeopleWhere(me, { companyId: ORG_B })).toEqual({
        AND: [
          {
            AND: [
              { companyId: ORG_B, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null },
              { company: { deletedAt: null } },
            ],
          },
          LISTED,
        ],
      });
    });

    it('an unknown X-Org-Id is refused as not found', () => {
      const me = actor(Role.SUPER_ADMIN, { orgHeaderInvalid: true });
      expect(codeOf(() => agentHealthPeopleWhere(me, {}))).toBe('ORG_NOT_FOUND');
    });

    it('never lists Super Admins or the Super Manager, nor blocked people', () => {
      for (const me of [actor(Role.ADMIN), actor(Role.SUPER_MANAGER)]) {
        const where = agentHealthPeopleWhere(me, {}) as { AND: Record<string, unknown>[] };
        expect(where.AND).toContainEqual(LISTED);
      }
    });
  });
});
