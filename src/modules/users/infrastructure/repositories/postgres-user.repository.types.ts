import { Prisma } from '@prisma/client';
import { Role } from '@shared/rbac/roles.enum';

const DEPARTMENT_REF = { select: { id: true, name: true, icon: true, deletedAt: true } } as const;

/**
 * Loaded with every user: role, organisation, 4.0 department and (for Managers)
 * the departments they oversee. Prisma batches the relations, so a page of users
 * costs one query per relation, not one per person.
 */
export const WITH_RELATIONS = {
  role: true,
  company: true,
  departmentRef: DEPARTMENT_REF,
  managedDepartments: {
    where: { department: { deletedAt: null } },
    select: { department: DEPARTMENT_REF },
  },
} as const satisfies Prisma.UserInclude;

export type PrismaUserWithRelations = Prisma.UserGetPayload<{ include: typeof WITH_RELATIONS }>;

export type UserWriteModel = {
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: Role;
  designation?: string | null;
  department?: string | null;
  managerId?: string | null;
  companyId?: string | null;
  shiftId?: string | null;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  /** Undefined on create, so the column keeps its `true` default. */
  screenshotsEnabled?: boolean;
  /** 4.0 */
  departmentId?: string | null;
  grants?: { screenshots: boolean; timeline: boolean; activity: boolean };
  idleEnabled?: boolean | null;
  idleMinutes?: number | null;
};
