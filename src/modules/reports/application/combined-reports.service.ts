import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { allOrgsInView, OrgRef, OrgsInViewService, withOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { teamTotals } from '../domain/report-builder';
import {
  PersonMonthReport,
  ReportPerson,
  TeamDayReport,
  TeamMonthReport,
} from '../domain/report.types';
import { ReportsService } from './reports.service';

/** A report person tagged with their organisation (3.3: every person view names it). */
export type OrgReportPerson = ReportPerson & {
  companyId: string | null;
  companyName: string | null;
};

export interface CombinedMonth {
  persons: PersonMonthReport[];
  team: TeamMonthReport;
}

/** Team month per organisation, concatenated; totals summed again over every person. */
export function combineTeamMonth(
  results: { org: OrgRef; value: CombinedMonth }[],
  month: string,
  today: string,
  now: Date,
): CombinedMonth {
  if (results.length === 1) {
    const [{ org, value }] = results;
    return {
      persons: value.persons.map((p) => ({ ...p, person: withOrg(p.person, org) })),
      team: {
        ...value.team,
        rows: value.team.rows.map((r) => ({ ...r, person: withOrg(r.person, org) })),
      },
    };
  }
  const persons = results.flatMap(({ org, value }) =>
    value.persons.map((p) => ({ ...p, person: withOrg(p.person, org) })),
  );
  const rows = results.flatMap(({ org, value }) =>
    value.team.rows.map((r) => ({ ...r, person: withOrg(r.person, org) })),
  );
  return {
    persons,
    team: {
      month,
      scope: results.every((r) => r.value.team.scope === 'ALL') ? 'ALL' : 'TEAM',
      // Locked only when every organisation's month is locked.
      locked: results.length > 0 && results.every((r) => r.value.team.locked),
      generatedAt: now.toISOString(),
      totals: teamTotals(
        persons.map((p) => ({ totals: p.totals, days: p.days })),
        today,
      ),
      rows,
    },
  };
}

/**
 * 3.3 combined reports for the Super Manager and the Super Admin on "All
 * organisations" (GET /reports/people, /team/day, /team/month and its export).
 * 4.0 builds every report with the organisation's own settings, calendar and month
 * lock, so each organisation is built on its own (acting in it) and the answers
 * are concatenated grouped by organisation, every person tagged with it. Inside one
 * organisation nothing changes (rows still carry companyId and companyName).
 */
@Injectable()
export class CombinedReportsService {
  constructor(
    private readonly reports: ReportsService,
    private readonly orgs: OrgsInViewService,
  ) {}

  /**
   * Runs `fn` per organisation in view. With `userIds` on "All organisations",
   * each organisation gets only its own people (and is skipped with none); an id
   * of nobody in a live organisation is unknown (404).
   */
  private async perOrg<T>(
    me: AuthenticatedUser,
    companyId: string | undefined,
    userIds: string[] | undefined,
    needsOneOrg: boolean,
    fn: (me: AuthenticatedUser, userIds: string[] | undefined) => Promise<T>,
  ): Promise<{ org: OrgRef; value: T }[]> {
    const split = !!userIds?.length && allOrgsInView(me) && !companyId;
    const orgOf = split ? await this.orgs.orgsOfPeople(userIds!) : null;
    if (orgOf && userIds!.some((id) => !orgOf.has(id))) throw new NotFoundError('Unknown person');
    const { results } = await this.orgs.each(
      me,
      companyId,
      async (run) => {
        const ids = orgOf ? userIds!.filter((id) => orgOf.get(id) === run.org.id) : userIds;
        if (orgOf && !ids?.length) return null;
        return fn(run.me, ids);
      },
      { needsOneOrg },
    );
    return results.filter((r): r is { org: OrgRef; value: Awaited<T> } => r.value !== null);
  }

  async people(
    me: AuthenticatedUser,
    now: Date,
    companyId?: string,
  ): Promise<{ items: OrgReportPerson[] }> {
    const results = await this.perOrg(me, companyId, undefined, false, (m) =>
      this.reports.people(m, now),
    );
    return { items: results.flatMap(({ org, value }) => value.items.map((p) => withOrg(p, org))) };
  }

  async teamDay(
    me: AuthenticatedUser,
    q: { date?: string; userIds?: string[]; departmentId?: string; companyId?: string },
    now: Date,
  ): Promise<TeamDayReport> {
    const results = await this.perOrg(me, q.companyId, q.userIds, !!q.departmentId, (m, ids) =>
      this.reports.teamDay(m, q.date, ids, now, q.departmentId),
    );
    return {
      date: results[0]?.value.date ?? q.date ?? dateKeyInZone(now, appTimezone()),
      rows: results.flatMap(({ org, value }) =>
        value.rows.map((r) => ({ ...r, person: withOrg(r.person, org) })),
      ),
    };
  }

  async teamMonthWithPersons(
    me: AuthenticatedUser,
    month: string,
    q: { managerId?: string; userIds?: string[]; departmentId?: string; companyId?: string },
    now: Date,
  ): Promise<CombinedMonth> {
    // An empty combined answer still validates the month (400 for a future one).
    await this.reports.assertMonthInRange(month, now);
    const results = await this.perOrg(
      me,
      q.companyId,
      q.userIds,
      !!(q.departmentId || q.managerId),
      (m, ids) =>
        this.reports.teamMonthWithPersons(m, month, q.managerId, ids, now, q.departmentId),
    );
    return combineTeamMonth(results, month, dateKeyInZone(now, appTimezone()), now);
  }

  /** The caller acting in a person's organisation, for one-person reports. */
  actingForPerson(me: AuthenticatedUser, userId: string): Promise<AuthenticatedUser> {
    return this.orgs.actingForPerson(me, userId);
  }
}
