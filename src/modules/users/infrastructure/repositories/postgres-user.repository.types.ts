import { Company as PrismaCompany, Role as PrismaRole, User as PrismaUser } from '@prisma/client';
import { Role } from '@shared/rbac/roles.enum';

export const WITH_RELATIONS = { role: true, company: true } as const;

export type PrismaUserWithRelations = PrismaUser & {
  role: PrismaRole;
  company: PrismaCompany | null;
};

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
};
