import { Role } from '@shared/rbac/roles.enum';

export interface PublicRole {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
}

export interface CreateRoleInput {
  name: Role;
  permissionCodes: string[];
}
