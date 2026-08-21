import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { UserMapper } from '../mappers/user.mapper';
import { UserAccessService } from '../../domain/services/user-access.service';
import {
  ListUsersFilter,
  USER_REPOSITORY,
  UserRepository,
} from '../../domain/repositories/user.repository';
import { ListUsersQueryDto } from '../dto';
import { ListUsersResult } from '../user.types';

/**
 * The joined-date filter is picked from a date picker, so both ends mean whole local
 * days: "from the 1st" includes everything on the 1st, "to the 5th" includes
 * everything up to the last moment of the 5th. Comparing a bare date against a
 * timestamp would otherwise exclude everyone who joined later in the day.
 */
function startOfDay(date?: string): Date | undefined {
  if (!date) return undefined;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date?: string): Date | undefined {
  if (!date) return undefined;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setHours(23, 59, 59, 999);
  return d;
}

@Injectable()
export class ListUsersUseCase {
  private readonly access = new UserAccessService();

  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(me: AuthenticatedUser, query: ListUsersQueryDto = {}): Promise<ListUsersResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const scope = this.access.listScopeFor(me);

    const base: ListUsersFilter = {
      search: query.search,
      sort: query.sort,
      // Every filter is independent and they combine: Role AND Team AND Company AND
      // joined-date range. Role used to be dropped whenever managerId was present
      // (they were an either/or), which silently broke the Role filter on every
      // manager-scoped screen.
      role: query.role,
      department: query.department,
      companyId: query.companyId,
      managerId: query.managerId,
      joinedFrom: startOfDay(query.joinedFrom),
      joinedTo: endOfDay(query.joinedTo),
      // Last, so the caller's own visibility always wins: a manager passing someone
      // else's managerId still only ever sees their own reports.
      ...scope,
    };
    const [list, total] = await Promise.all([
      this.users.findAll({ ...base, skip: (page - 1) * limit, take: limit }),
      this.users.count(base),
    ]);

    return { users: list.map(UserMapper.toListItem), total, page, limit };
  }
}
