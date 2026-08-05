import { BulkError } from '@shared/types/common.types';
import { PaginatedResult } from '@shared/types/pagination.types';
import { UserStatus } from '@shared/types/user.types';

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  department: string | null;
  designation: string | null;
  managerId: string | null;
  companyId: string | null;
  shiftId: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  status: UserStatus;
  createdAt: string;
}

export interface UserListItem {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  department: string | null;
  company: string | null;
  status: UserStatus;
  createdAt: string;
}

export type ListUsersResult = PaginatedResult<'users', UserListItem>;

export interface CreateUsersResult {
  created: PublicUser[];
  errors: BulkError<'email'>[];
}

export interface DeleteUserResult {
  deleted: true;
  id: string;
}
