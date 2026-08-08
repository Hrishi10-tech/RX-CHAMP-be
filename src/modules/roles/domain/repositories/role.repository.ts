import { Role } from '@shared/rbac/roles.enum';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

export interface RoleRecord {
  id: string;
  name: string;
  permissions: string[];
  createdAt: Date;
}

export interface CreateRoleData {
  name: Role;
  permissionCodes: string[];
}

export interface RoleRepository {
  findByName(name: Role): Promise<RoleRecord | null>;
  create(data: CreateRoleData): Promise<RoleRecord>;
}
