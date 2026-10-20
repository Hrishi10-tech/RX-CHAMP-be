import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  canSeePerson,
  canViewSection,
  isAdminLike,
  managedDeptIds,
  requireOrg,
  Section,
} from '@shared/tenancy';
import {
  PeopleFilter,
  PersonRow,
  WORKTIME_READER,
  WorktimeReader,
} from '../domain/worktime.reader';

export interface ScopeOptions {
  /** 3.x: one manager's team. Ignored since 4.0 (scope is by department). */
  managerId?: string;
  /** Only these people (each must be in scope, else 404). */
  userIds?: string[];
  /** 4.0: only this department (must be one the caller may see). */
  departmentId?: string;
  /** Period the view covers: inactive people appear only if they worked in it. */
  fromDate: string;
  toDate: string;
}

/** "Asha Rao" */
export function nameOf(p: Pick<PersonRow, 'firstName' | 'lastName'>): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

/** PersonRow as the facts scope decisions need. */
function facts(p: PersonRow) {
  return { id: p.id, role: p.role, companyId: p.companyId, departmentId: p.departmentId };
}

/**
 * Who a caller may see in Team, Overview, hourly activity and reports
 * (docs/4.0/SPEC.md 1.2): an Admin or Super Admin (with an organisation chosen)
 * everyone in the organisation but Super Admins; a Manager the Staff of their
 * departments (nobody without departments). People blocked or deleted appear only
 * in periods where they have work sessions. Outside scope answers 404.
 */
@Injectable()
export class PeopleScopeService {
  constructor(@Inject(WORKTIME_READER) private readonly reader: WorktimeReader) {}

  assertManagerOrAdmin(me: AuthenticatedUser): void {
    if (!isAdminLike(me) && me.role !== Role.MANAGER) {
      throw new ForbiddenError('Only managers and admins can see this.');
    }
    requireOrg(me);
  }

  /** The reader filter for everyone the caller may see. */
  filterFor(me: AuthenticatedUser): PeopleFilter | null {
    const companyId = requireOrg(me);
    if (isAdminLike(me)) return { companyId, excludeRoles: ['SUPER_ADMIN'] };
    const depts = managedDeptIds(me);
    if (!depts.length) return null;
    return { companyId, roles: ['USER'], departmentIds: depts };
  }

  async scope(me: AuthenticatedUser, opts: ScopeOptions): Promise<PersonRow[]> {
    this.assertManagerOrAdmin(me);
    const filter = this.filterFor(me);
    if (!filter) return [];
    if (opts.departmentId) {
      if (filter.departmentIds && !filter.departmentIds.includes(opts.departmentId)) {
        throw new NotFoundError('Unknown department');
      }
      if (!filter.departmentIds) {
        // Admin: the department must be one of the organisation's.
        const own = await this.reader.departmentsOf(filter.companyId!);
        if (!own.some((d) => d.id === opts.departmentId)) {
          throw new NotFoundError('Unknown department');
        }
      }
      filter.departmentIds = [opts.departmentId];
    }
    let base = await this.reader.listPeople(filter);
    if (opts.userIds) {
      const inScope = new Set(base.map((p) => p.id));
      if (opts.userIds.some((id) => !inScope.has(id))) {
        throw new NotFoundError('Unknown person');
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

  /** One person the caller may see (404 unknown or outside scope). */
  async person(me: AuthenticatedUser, userId: string): Promise<PersonRow> {
    this.assertManagerOrAdmin(me);
    const [target] = await this.reader.listPeople({ ids: [userId] });
    if (!target || !canSeePerson(me, facts(target))) {
      throw new NotFoundError('Unknown person');
    }
    return target;
  }

  /** One person and one detail section (403 GRANT_REQUIRED when not granted). */
  async personSection(me: AuthenticatedUser, userId: string, section: Section): Promise<PersonRow> {
    const target = await this.person(me, userId);
    if (!canViewSection(me, facts(target), section)) {
      throw new ForbiddenError(
        `You do not have access to ${section === 'timeline' ? 'the timeline' : section}.`,
        'GRANT_REQUIRED',
      );
    }
    return target;
  }
}
