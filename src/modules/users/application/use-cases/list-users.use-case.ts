import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { isAdminLike } from '@shared/tenancy';
import { UserMapper } from '../mappers/user.mapper';
import { UserAccessService } from '../../domain/services/user-access.service';
import {
  ListUsersFilter,
  USER_REPOSITORY,
  UserRepository,
} from '../../domain/repositories/user.repository';
import {
  AGENT_PRESENCE_READER,
  AgentPresenceReader,
} from '../../domain/repositories/agent-presence.reader';
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

/**
 * GET /users (docs/4.0/SPEC.md 5.3).
 *  - Admin, Super Admin (organisation selected): everyone in the organisation with
 *    department, managed departments, grants, input-tracking override and agent state.
 *  - Manager: the Staff of their departments, name, email, designation and department only.
 *  - Staff: themselves, the same few fields.
 * The caller's scope is applied last, so no filter can reach outside it.
 */
@Injectable()
export class ListUsersUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AGENT_PRESENCE_READER) private readonly presence: AgentPresenceReader,
  ) {}

  async execute(me: AuthenticatedUser, query: ListUsersQueryDto = {}): Promise<ListUsersResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const scope = this.access.listScopeFor(me);

    // A department filter narrows a Manager's own departments, never widens them.
    let departmentIds = scope.departmentIds;
    if (query.departmentId) {
      departmentIds = departmentIds
        ? departmentIds.filter((id) => id === query.departmentId)
        : [query.departmentId];
    }

    const base: ListUsersFilter = {
      search: (query.q ?? query.search)?.trim() || undefined,
      sort: query.sort,
      role: query.role,
      status: query.status,
      department: query.department,
      joinedFrom: startOfDay(query.joinedFrom),
      joinedTo: endOfDay(query.joinedTo),
      ...scope,
      departmentIds,
    };
    const [list, total] = await Promise.all([
      this.users.findAll({ ...base, skip: (page - 1) * limit, take: limit }),
      this.users.count(base),
    ]);

    if (!isAdminLike(me)) {
      return { users: list.map((u) => UserMapper.toBrief(u)), total, page, limit };
    }

    // Grouped lookups for the whole page, so the Status column costs a fixed few
    // queries rather than several per row.
    const now = new Date();
    const presence = await this.presence.presenceFor(list.map((u) => u.id));
    return {
      users: list.map((u) => UserMapper.toListItem(u, presence.get(u.id), now)),
      total,
      page,
      limit,
    };
  }
}
