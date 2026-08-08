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

@Injectable()
export class ListUsersUseCase {
  private readonly access = new UserAccessService();

  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(me: AuthenticatedUser, query: ListUsersQueryDto = {}): Promise<ListUsersResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const scope = this.access.listScopeFor(me);
    const drillDown = query.managerId ? { managerId: query.managerId } : { role: query.role };
    const base: ListUsersFilter = {
      search: query.search,
      sort: query.sort,
      ...drillDown,
      ...scope,
    };
    const [list, total] = await Promise.all([
      this.users.findAll({ ...base, skip: (page - 1) * limit, take: limit }),
      this.users.count(base),
    ]);

    return { users: list.map(UserMapper.toListItem), total, page, limit };
  }
}
