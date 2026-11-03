import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { OrgsInViewService } from '@shared/tenancy';
import { scopeSql } from '../infrastructure/prisma-approvals.reader';
import { approverScopeOf } from './approver-scope';
import { combineTeamToday, CombinedViewsService } from './combined-views.service';
import { TeamTodayView } from './worktime.types';

/** 3.3 combined views ("All organisations") over 4.0's per-organisation services. */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-03T06:00:00Z');

function actor(role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const platform = role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER;
  return {
    id: `${role.toLowerCase()}-me`,
    email: 'x@x.test',
    role,
    permissions: [],
    department: null,
    companyId: platform ? null : ORG_A,
    status: 'ACTIVE',
    orgId: platform ? null : ORG_A,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    ...over,
  } as AuthenticatedUser;
}

describe('approverScopeOf (3.3)', () => {
  it('All organisations: ANY_ORG; the Super Admin keeps mine (the Admin pool), the Super Manager never', () => {
    expect(approverScopeOf(actor(Role.SUPER_ADMIN))).toEqual({
      kind: 'ANY_ORG',
      adminMine: true,
      excludeUserId: 'super_admin-me',
    });
    expect(approverScopeOf(actor(Role.SUPER_MANAGER), 'mine', ORG_B)).toEqual({
      kind: 'ANY_ORG',
      companyId: ORG_B,
      adminMine: false,
      excludeUserId: 'super_manager-me',
    });
  });

  it('every 4.0 scope is unchanged', () => {
    expect(approverScopeOf(actor(Role.ADMIN))).toMatchObject({
      kind: 'ORG_ADMIN_MINE',
      companyId: ORG_A,
    });
    expect(approverScopeOf(actor(Role.ADMIN), 'all')).toMatchObject({
      kind: 'ORG',
      companyId: ORG_A,
    });
    expect(approverScopeOf(actor(Role.MANAGER), 'all', ORG_B)).toMatchObject({
      kind: 'DEPTS',
      companyId: ORG_A,
      departmentIds: ['d1'],
    });
    expect(approverScopeOf(actor(Role.SUPER_MANAGER, { orgId: ORG_A }))).toMatchObject({
      kind: 'ORG',
      companyId: ORG_A,
    });
    expect(approverScopeOf(actor(Role.USER))).toBeNull();
  });
});

describe('scopeSql ANY_ORG', () => {
  it('limits to people of live organisations, optionally one, never the caller', () => {
    const all = scopeSql({ kind: 'ANY_ORG', excludeUserId: 'me' });
    expect(all.sql).toContain(
      'JOIN companies sc ON sc.id = su.company_id AND sc.deleted_at IS NULL',
    );
    expect(all.sql).not.toContain('su.company_id = ');
    expect(all.values).toEqual(['me']);
    const one = scopeSql({
      kind: 'ANY_ORG',
      companyId: ORG_B,
      excludeUserId: 'me',
      adminMine: true,
    });
    expect(one.sql).toContain('su.company_id = ');
    expect(one.sql).toContain("a.approver_role IN ('ADMIN', 'SUPER_ADMIN')");
    expect(one.values).toEqual([ORG_B, 'me']);
  });
});

function today(rows: string[], focusSec: number): TeamTodayView {
  return {
    date: '2026-11-03',
    serverNow: NOW.toISOString(),
    totals: {
      people: rows.length,
      started: rows.length,
      notStarted: 0,
      onBreak: 1,
      inMeeting: 0,
      ended: 0,
      lateStarts: 0,
      pendingApprovals: 2,
      overdueApprovals: 1,
      focusSec,
      quietHours: 0,
    },
    rows: rows.map(
      (id) => ({ user: { id, name: id } }) as unknown as TeamTodayView['rows'][number],
    ),
  };
}

describe('combineTeamToday', () => {
  it('concatenates grouped by organisation, tags every row, adds the totals', () => {
    const out = combineTeamToday(
      [
        { org: { id: ORG_A, name: 'Acme' }, value: today(['a1', 'a2'], 100) },
        { org: { id: ORG_B, name: 'Beta' }, value: today(['b1'], 50) },
      ],
      '2026-11-03',
      NOW,
    );
    expect(out.rows.map((r) => [r.user.id, r.user.companyName])).toEqual([
      ['a1', 'Acme'],
      ['a2', 'Acme'],
      ['b1', 'Beta'],
    ]);
    expect(out.totals).toMatchObject({ people: 3, onBreak: 2, overdueApprovals: 2, focusSec: 150 });
  });
});

describe('CombinedViewsService', () => {
  const orgs = [
    { id: ORG_A, name: 'Acme' },
    { id: ORG_B, name: 'Beta' },
  ];
  const prisma = {
    company: {
      findMany: jest.fn(async () => orgs),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null,
      ),
    },
  };
  const orgsInView = new OrgsInViewService(prisma as never);
  const teamToday = {
    today: jest.fn(async (me: AuthenticatedUser) => today([`${me.orgId}-p`], 60)),
  };
  const teamOverview = {
    orgToday: jest.fn(async (me: AuthenticatedUser) => ({
      people: me.orgId === ORG_A ? 3 : 2,
      started: 1,
      working: 1,
      onBreak: 0,
      inMeeting: 0,
      away: 0,
      notStarted: 1,
      ended: 0,
      lateStarts: 0,
      focusSec: 600,
      targetSec: 1000,
      noAgent: 0,
    })),
  };
  const approvals = {
    list: jest.fn(async () => ({
      items: [],
      meta: { total: 4, page: 1, limit: 6, totalPages: 1 },
    })),
  };
  const reader = {
    count: jest.fn(async (_q: unknown) => 2),
    overdueIn: jest.fn(async () => ({ count: 1, oldestDueAt: NOW })),
  };
  const svc = new CombinedViewsService(
    orgsInView,
    teamToday as never,
    teamOverview as never,
    approvals as never,
    reader as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('Team today on All organisations runs once per organisation, acting in each', async () => {
    const out = await svc.teamToday(actor(Role.SUPER_MANAGER), {}, NOW);
    expect(teamToday.today.mock.calls.map((c) => (c[0] as AuthenticatedUser).orgId)).toEqual([
      ORG_A,
      ORG_B,
    ]);
    expect(out.rows.map((r) => r.user.companyName)).toEqual(['Acme', 'Beta']);
    await expect(
      svc.teamToday(actor(Role.SUPER_MANAGER), { departmentId: 'd1' }, NOW),
    ).rejects.toMatchObject({ code: 'ORG_REQUIRED' });
  });

  it('Team today for an Admin is the 4.0 answer with chips (the caller unchanged)', async () => {
    const admin = actor(Role.ADMIN);
    const out = await svc.teamToday(admin, {}, NOW);
    expect(teamToday.today).toHaveBeenCalledTimes(1);
    expect(teamToday.today.mock.calls[0][0]).toBe(admin);
    expect(out.rows[0].user.companyName).toBe('Acme');
  });

  it('the Overview: one card per organisation, totals in view and what waits for a decision', async () => {
    const out = await svc.organisations(actor(Role.SUPER_MANAGER), NOW);
    expect(out.scope).toEqual({ organisation: null, combined: true });
    expect(out.organisations.map((o) => [o.name, o.today.people, o.approvals.pending])).toEqual([
      ['Acme', 3, 2],
      ['Beta', 2, 2],
    ]);
    expect(out.totals).toMatchObject({ people: 5, pendingApprovals: 4, overdueApprovals: 2 });
    expect(out.organisations[0].agentIssues).toBeNull();
    // Per-organisation approvals are counted in that organisation's own scope.
    expect(reader.count.mock.calls[0][0]).toMatchObject({
      scope: { kind: 'ORG', companyId: ORG_A, excludeUserId: 'super_manager-me' },
    });
    expect(approvals.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'PENDING', scope: 'all', limit: 6 }),
      NOW,
    );
    expect(out.waiting.total).toBe(4);
  });

  it('the Overview is refused to everyone else', async () => {
    await expect(svc.organisations(actor(Role.ADMIN), NOW)).rejects.toMatchObject({ status: 403 });
  });
});
