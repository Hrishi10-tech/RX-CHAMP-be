import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { actingIn, allOrgsInView, OrgRef } from './combined';
import { requireOrg } from './scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One organisation a combined view covers, and the caller acting in it. */
export interface OrgRun {
  org: OrgRef;
  me: AuthenticatedUser;
}

/** What a list covers: one organisation (combined false), or every live one. */
export interface OrgPlan {
  /** True for "All organisations" with no companyId filter: rows carry org chips. */
  combined: boolean;
  runs: OrgRun[];
}

const unknownOrg = () => new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');

/**
 * Which organisations a list covers for the caller (3.3 combined views over 4.0):
 *  - Super Manager / Super Admin on "All organisations": every live organisation,
 *    or only `companyId` when asked (404 ORG_NOT_FOUND for a deleted or unknown one).
 *  - Everyone else, and those two with an organisation picked: the organisation
 *    they act in (requireOrg's refusals); a different `companyId` is 404.
 */
@Injectable()
export class OrgsInViewService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every live organisation, by name. */
  async live(): Promise<OrgRef[]> {
    const rows = await this.prisma.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** A live organisation, or null. */
  async find(id: string): Promise<OrgRef | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    });
    return row ? { id: row.id, name: row.name } : null;
  }

  async plan(me: AuthenticatedUser, companyId?: string): Promise<OrgPlan> {
    if (allOrgsInView(me)) {
      if (companyId) {
        const org = await this.find(companyId);
        if (!org) throw unknownOrg();
        return { combined: false, runs: [{ org, me: actingIn(me, org.id) }] };
      }
      const orgs = await this.live();
      return { combined: true, runs: orgs.map((org) => ({ org, me: actingIn(me, org.id) })) };
    }
    const own = requireOrg(me);
    if (companyId && companyId !== own) throw unknownOrg();
    const org = (await this.find(own)) ?? { id: own, name: '' };
    return { combined: false, runs: [{ org, me }] };
  }

  /**
   * Runs `fn` once per organisation in view and returns the answers in organisation
   * order. In a combined view, filters that only make sense inside one organisation
   * (a department, a manager) need `companyId` (400 ORG_REQUIRED).
   */
  async each<T>(
    me: AuthenticatedUser,
    companyId: string | undefined,
    fn: (run: OrgRun) => Promise<T>,
    opts: { needsOneOrg?: boolean } = {},
  ): Promise<{ combined: boolean; results: { org: OrgRef; value: T }[] }> {
    const plan = await this.plan(me, companyId);
    if (plan.combined && opts.needsOneOrg) {
      throw new ValidationError(
        'Choose an organisation first: this filter belongs to one organisation.',
        'ORG_REQUIRED',
      );
    }
    const results: { org: OrgRef; value: T }[] = [];
    // One organisation at a time: each run is a full aggregated read already.
    for (const run of plan.runs) results.push({ org: run.org, value: await fn(run) });
    return { combined: plan.combined, results };
  }

  /**
   * The caller acting in a person's organisation, for one-person reads opened from
   * a combined list. Only on "All organisations"; anyone else is returned as is and
   * the usual scope checks decide. A person with no live organisation is unknown.
   */
  async actingForPerson(me: AuthenticatedUser, userId: string): Promise<AuthenticatedUser> {
    if (!allOrgsInView(me)) return me;
    if (!UUID.test(userId)) throw new NotFoundError('Unknown person');
    const row = await this.prisma.user.findFirst({
      where: { id: userId, company: { deletedAt: null } },
      select: { companyId: true },
    });
    if (!row?.companyId) throw new NotFoundError('Unknown person');
    return actingIn(me, row.companyId);
  }

  /** The organisation of each of these people (unknown or none: absent). */
  async orgsOfPeople(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id) => UUID.test(id)))];
    if (!ids.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids }, companyId: { not: null }, company: { deletedAt: null } },
      select: { id: true, companyId: true },
    });
    return new Map(rows.map((r) => [r.id, r.companyId as string]));
  }
}
