import { Role } from '@shared/rbac/roles.enum';
import { SearchPageFilter } from '@shared/types/pagination.types';
import { UserStatus } from '@shared/types/user.types';
import { User } from '../entities/user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserData {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: Role;
  designation?: string;
  department?: string;
  managerId?: string;
  companyId?: string;
  shiftId?: string;
  shiftStart?: string;
  shiftEnd?: string;
}

/**
 * The orderings the user list supports, as the UI labels them:
 *   name_asc     Name (A – Z)
 *   name_desc    Name (Z – A)
 *   joined_desc  Joined Date (Newest)
 *   joined_asc   Joined Date (Oldest)
 *   role_asc     Role (A – Z)
 *   role_desc    Role (Z – A)
 */
export type UserSortOption =
  | 'name_asc'
  | 'name_desc'
  | 'joined_asc'
  | 'joined_desc'
  | 'role_asc'
  | 'role_desc';

export const USER_SORT_OPTIONS: UserSortOption[] = [
  'name_asc',
  'name_desc',
  'joined_asc',
  'joined_desc',
  'role_asc',
  'role_desc',
];

/** Newest first — what the list returned before sorting was configurable. */
export const DEFAULT_USER_SORT: UserSortOption = 'joined_desc';

export interface ListUsersFilter extends SearchPageFilter {
  ids?: string[];
  department?: string | null;
  managerId?: string;
  companyId?: string;
  role?: Role;
  status?: UserStatus;
  /** Inclusive lower bound on when the user joined. */
  joinedFrom?: Date;
  /** Inclusive upper bound on when the user joined. */
  joinedTo?: Date;
  sort?: UserSortOption;
}

export type ListUsersScope = Pick<ListUsersFilter, 'ids' | 'managerId'>;

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findAll(filter?: ListUsersFilter): Promise<User[]>;
  findByManager(managerId: string, filter?: ListUsersFilter): Promise<User[]>;
  count(filter?: ListUsersFilter): Promise<number>;
  create(data: CreateUserData): Promise<User>;
  save(user: User): Promise<User>;
  softDelete(id: string): Promise<void>;
  /**
   * Atomically stamps the first agent activation. Returns true only the first
   * time (when `agentActivatedAt` was still null) so callers can fire a
   * one-time "agent activated" notification without racing.
   */
  markAgentActivatedIfFirst(id: string): Promise<boolean>;
}
