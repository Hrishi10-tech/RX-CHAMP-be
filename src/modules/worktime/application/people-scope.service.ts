import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { PersonRow, WORKTIME_READER, WorktimeReader } from '../domain/worktime.reader';

export interface ScopeOptions {
  /** Super Admin: one manager's team. A Manager may only name themselves. */
  managerId?: string;
  /** Only these people (each must be in scope, else 403). */
  userIds?: string[];
  /** Period the view covers: inactive people appear only if they worked in it. */
  fromDate: string;
  toDate: string;
}

/** "Asha Rao" */
export function nameOf(p: Pick<PersonRow, 'firstName' | 'lastName'>): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

/**
 * Who a caller may see in Team today, hourly activity and reports (SPEC 1.9):
 * a Manager their direct reports (users.manager_id = me), not themselves; a Super
 * Admin everyone, managers and Super Admins included. People with status DISABLED
 * or deleted appear only in periods where they have work sessions.
 */
@Injectable()
export class PeopleScopeService {
  constructor(@Inject(WORKTIME_READER) private readonly reader: WorktimeReader) {}

  assertManagerOrAdmin(me: AuthenticatedUser): void {
    if (me.role !== Role.MANAGER && me.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError('Only managers and Super Admins can see this.');
    }
  }

  async scope(me: AuthenticatedUser, opts: ScopeOptions): Promise<PersonRow[]> {
    this.assertManagerOrAdmin(me);
    let base: PersonRow[];
    if (me.role === Role.MANAGER) {
      if (opts.managerId && opts.managerId !== me.id) {
        throw new ForbiddenError('You can only see your own team.');
      }
      base = await this.reader.listPeople({ managerId: me.id });
    } else if (opts.managerId) {
      const manager = await this.reader.listPeople({ ids: [opts.managerId] });
      if (!manager.length) throw new NotFoundError('Unknown manager');
      base = await this.reader.listPeople({ managerId: opts.managerId });
    } else {
      base = await this.reader.listPeople({});
    }
    if (opts.userIds) {
      const inScope = new Set(base.map((p) => p.id));
      if (opts.userIds.some((id) => !inScope.has(id))) {
        throw new ForbiddenError('You can only see people in your scope.');
      }
      const wanted = new Set(opts.userIds);
      base = base.filter((p) => wanted.has(p.id));
    }
    const inactive = base.filter((p) => !p.active).map((p) => p.id);
    const worked = inactive.length
      ? await this.reader.userIdsWithSessionsBetween(inactive, opts.fromDate, opts.toDate)
      : new Set<string>();
    return base.filter((p) => p.active || worked.has(p.id));
  }

  /** One person the caller may see (404 unknown, 403 outside scope). */
  async person(me: AuthenticatedUser, userId: string): Promise<PersonRow> {
    this.assertManagerOrAdmin(me);
    const [target] = await this.reader.listPeople({ ids: [userId] });
    if (!target) throw new NotFoundError('Unknown person');
    if (me.role === Role.MANAGER && target.managerId !== me.id) {
      throw new ForbiddenError('That person is not in your team.');
    }
    return target;
  }
}
