import { UserStatus } from '@shared/types/user.types';
import { Permission } from './permissions.enum';
import { Role } from './roles.enum';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  permissions: Permission[];
  department: string | null;
  companyId: string | null;
  status: UserStatus;
}
