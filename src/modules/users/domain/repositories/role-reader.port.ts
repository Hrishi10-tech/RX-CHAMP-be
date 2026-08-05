
import { Role } from '@shared/rbac/roles.enum';

export const ROLE_READER = Symbol('ROLE_READER');

export interface RoleView {
  id: string;
  name: Role;
}

export interface RoleReader {
  findByName(name: Role): Promise<RoleView | null>;
}
