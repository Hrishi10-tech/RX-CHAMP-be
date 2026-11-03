import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { seesEveryOrg } from '@shared/rbac/roles.enum';
import { OrgRef, OrgsInViewService, sumTotals, withOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { ApprovalsService } from './approvals.service';
import { approverScopeOf } from './approver-scope';
import { OrgTodayNumbers, TeamOverviewService } from './team-overview.service';
import { TeamTodayService } from './team-today.service';
import { ApprovalItemView, TeamTodayView } from './worktime.types';

const EMPTY_TODAY: OrgTodayNumbers = {
  people: 0,
  started: 0,
  working: 0,
  onBreak: 0,
  inMeeting: 0,
  away: 0,
  notStarted: 0,
  ended: 0,
  lateStarts: 0,
  focusSec: 0,
  targetSec: 0,
  noAgent: 0,
};

const EMPTY_TEAM_TOTALS: TeamTodayView['totals'] = {
  people: 0,
  started: 0,
  notStarted: 0,
  onBreak: 0,
  inMeeting: 0,
  ended: 0,
  lateStarts: 0,
  pendingApprovals: 0,
  overdueApprovals: 0,
  focusSec: 0,
  quietHours: 0,
};

/** One organisation's card on the Super Manager's Overview. */
export interface OrgCardView {
  id: string;
  name: string;
  today: OrgTodayNumbers;
  approvals: { pending: number; overdue: number; oldestDueAt: string | null };
  /**
   * Agent issues come from Agent health (GET /agent-health, built separately); null
   * here: the portal reads them from that endpoint per organisation.
   */
  agentIssues: number | null;
}

export interface OrganisationsOverviewView {
  scope: { organisation: OrgRef | null; combined: boolean };
  totals: OrgTodayNumbers & { pendingApprovals: number; overdueApprovals: number };
  organisations: OrgCardView[];
  /** The first pending items in view (every organisation's, combined). */
  waiting: { items: ApprovalItemView[]; total: number };
  generatedAt: string;
}

/**
 * Team today, run per organisation and concatenated (grouped by organisation),
 * every row tagged with its organisation; totals added up.
 */
export function combineTeamToday(
  results: { org: OrgRef; value: TeamTodayView }[],
  date: string,
  now: Date,
): TeamTodayView {
  return {
    date: results.length === 1 ? results[0].value.date : date,
    serverNow: now.toISOString(),
    totals: sumTotals(
      results.map((r) => r.value.totals),
      EMPTY_TEAM_TOTALS,
    ),
    rows: results.flatMap(({ org, value }) =>
      value.rows.map((row) => ({ ...row, user: withOrg(row.user, org) })),
    ),
  };
}

/**
 * 3.3 combined views over 4.0's one-organisation services (see shared/tenancy
 * combined.ts): Team today for "All organisations", and the Super Manager's
 * Overview (one card per organisation). Each organisation is computed with its own
 * settings and calendar, acting in it, then the answers are concatenated.
 */
@Injectable()
export class CombinedViewsService {
  constructor(
    private readonly orgs: OrgsInViewService,
    private readonly teamTodayService: TeamTodayService,
    private readonly teamOverview: TeamOverviewService,
    private readonly approvals: ApprovalsService,
    @Inject(APPROVALS_READER) private readonly reader: ApprovalsReader,
  ) {}

  /** GET /team/today, with organisation chips and the optional companyId. */
  async teamToday(
    me: AuthenticatedUser,
    q: { date?: string; managerId?: string; departmentId?: string; companyId?: string },
    now: Date,
  ): Promise<TeamTodayView> {
    const { results } = await this.orgs.each(
      me,
      q.companyId,
      (run) => this.teamTodayService.today(run.me, q, now),
      { needsOneOrg: !!(q.managerId || q.departmentId) },
    );
    return combineTeamToday(results, q.date ?? dateKeyInZone(now, appTimezone()), now);
  }

  /** GET /overview/organisations: the Super Manager's (and Super Admin's) home. */
  async organisations(
    me: AuthenticatedUser,
    now: Date,
    companyId?: string,
  ): Promise<OrganisationsOverviewView> {
    if (!seesEveryOrg(me.role)) {
      throw new ForbiddenError('Only the Super Manager and Super Admins can see this.');
    }
    const plan = await this.orgs.plan(me, companyId);
    const cards: OrgCardView[] = [];
    for (const run of plan.runs) {
      const scope = approverScopeOf(run.me, 'all');
      const [today, pending, overdue] = await Promise.all([
        this.teamOverview.orgToday(run.me, now),
        scope ? this.reader.count({ scope, statuses: ['PENDING'] }) : Promise.resolve(0),
        scope
          ? this.reader.overdueIn(scope, now)
          : Promise.resolve({ count: 0, oldestDueAt: null as Date | null }),
      ]);
      cards.push({
        id: run.org.id,
        name: run.org.name,
        today,
        approvals: {
          pending,
          overdue: overdue.count,
          oldestDueAt: overdue.oldestDueAt?.toISOString() ?? null,
        },
        agentIssues: null,
      });
    }
    const waiting = await this.approvals.list(
      me,
      { status: 'PENDING', scope: 'all', companyId, page: 1, limit: 6 },
      now,
    );
    const today = sumTotals(
      cards.map((c) => c.today),
      EMPTY_TODAY,
    );
    return {
      scope: {
        organisation: plan.combined ? null : (plan.runs[0]?.org ?? null),
        combined: plan.combined,
      },
      totals: {
        ...today,
        pendingApprovals: cards.reduce((s, c) => s + c.approvals.pending, 0),
        overdueApprovals: cards.reduce((s, c) => s + c.approvals.overdue, 0),
      },
      organisations: cards,
      waiting: { items: waiting.items, total: waiting.meta.total },
      generatedAt: now.toISOString(),
    };
  }
}
