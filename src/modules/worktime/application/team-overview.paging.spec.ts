import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { parsePageParams } from '@shared/utils/pagination';
import { TeamOverviewService } from './team-overview.service';

/**
 * Paging on GET /team and GET /overview: filter first, then page; counts and
 * totals cover everyone the filters match; a fixed order so pages never overlap.
 */
const ORG = 'c1';
const NOW = new Date('2026-10-20T06:00:00.000Z');
const admin = {
  id: 'me',
  role: Role.ADMIN,
  companyId: ORG,
  orgId: ORG,
  managedDepartmentIds: [],
  grants: { screenshots: true, timeline: true, activity: true },
} as unknown as AuthenticatedUser;

const pad = (n: number) => String(n).padStart(2, '0');

/** 25 people: 1..15 in d1, 16..25 in d2; odd numbers are working. */
const PEOPLE = Array.from({ length: 25 }, (_, i) => {
  const n = 25 - i; // given out of order on purpose
  return {
    id: `u${pad(n)}`,
    firstName: 'Person',
    lastName: pad(n),
    email: `p${pad(n)}@x.test`,
    role: 'USER',
    department: null,
    designation: n === 7 ? 'Night lead' : null,
    companyId: ORG,
    departmentId: n <= 15 ? 'd1' : 'd2',
    managerId: null,
    managerName: null,
    active: true,
    joinedOn: '2026-01-01',
  };
});

function setup() {
  const reader = {
    departmentsOf: jest.fn().mockResolvedValue([
      { id: 'd1', name: 'Billing' },
      { id: 'd2', name: 'Coding' },
    ]),
    presenceOverlapping: jest.fn().mockResolvedValue([]),
    liveFacts: jest.fn().mockResolvedValue(new Map()),
  };
  const scope = { scope: jest.fn().mockResolvedValue(PEOPLE) };
  const days = {
    load: jest.fn().mockResolvedValue({
      day: (p: { lastName: string }) => ({
        data: {
          sessions:
            Number(p.lastName) % 2
              ? [{ startedAt: new Date('2026-10-20T03:00:00Z'), endedAt: null }]
              : [],
          presence: [],
        },
        summary: {
          startedAt: null,
          focusSec: 0,
          targetSec: 0,
          unverifiedSec: 0,
          paidSec: 0,
          lateStart: null,
        },
        plan: { isWorkingDay: true },
      }),
    }),
  };
  const breakDays = {
    context: jest.fn().mockResolvedValue({}),
    dayWith: jest.fn().mockReturnValue({ dateKey: '2026-10-20' }),
  };
  const svc = new TeamOverviewService(
    reader as never,
    {} as never,
    scope as never,
    days as never,
    breakDays as never,
    {} as never,
  );
  return { svc };
}

describe('parsePageParams', () => {
  const opts = { defaultLimit: 10, maxLimit: 100 };
  it('defaults to page 1, limit 10', () => {
    expect(parsePageParams({}, opts)).toEqual({ page: 1, limit: 10 });
  });
  it('falls back to the defaults on bad values, never throws', () => {
    for (const bad of ['0', '-5', 'abc', '1.5', '', ' ', 'NaN', '1e3']) {
      expect(parsePageParams({ page: bad, limit: bad }, opts)).toEqual({ page: 1, limit: 10 });
    }
  });
  it('caps limit at the maximum', () => {
    expect(parsePageParams({ page: '3', limit: '500' }, opts)).toEqual({ page: 3, limit: 100 });
  });
});

describe('GET /team paging', () => {
  it('returns one page with meta; counts cover everyone, not the page', async () => {
    const { svc } = setup();
    const res = await svc.team(admin, { page: '1', limit: '10' }, NOW);
    expect(res.people).toHaveLength(10);
    expect(res.meta).toEqual({ page: 1, limit: 10, total: 25, totalPages: 3 });
    expect(res.counts.all).toBe(25);
    expect(res.counts.working).toBe(13);
    expect(res.counts.notStarted).toBe(12);
  });

  it('pages in a fixed name order with no repeats or gaps', async () => {
    const { svc } = setup();
    const seen: string[] = [];
    for (const page of ['1', '2', '3']) {
      const res = await svc.team(admin, { page, limit: '10' }, NOW);
      seen.push(...res.people.map((p) => p.id));
    }
    expect(seen).toEqual(PEOPLE.map((p) => p.id).sort());
    const past = await svc.team(admin, { page: '4', limit: '10' }, NOW);
    expect(past.people).toEqual([]);
    expect(past.meta.total).toBe(25);
  });

  it('filters first, then pages: view, departmentId and q set total; counts ignore only view', async () => {
    const { svc } = setup();
    const dept = await svc.team(admin, { departmentId: 'd2', view: 'active', limit: '3' }, NOW);
    expect(dept.meta).toEqual({ page: 1, limit: 3, total: 5, totalPages: 2 });
    expect(dept.counts.all).toBe(10);
    expect(dept.counts.active).toBe(5);

    // Search covers everyone in scope, not just the page that was downloaded.
    const found = await svc.team(admin, { q: 'night', page: '1', limit: '1' }, NOW);
    expect(found.people.map((p) => p.id)).toEqual(['u07']);
    expect(found.meta.total).toBe(1);
    expect(found.counts.all).toBe(1);
  });

  it('bad page values fall back to the defaults', async () => {
    const { svc } = setup();
    const res = await svc.team(admin, { page: '0', limit: 'abc' }, NOW);
    expect(res.meta).toMatchObject({ page: 1, limit: 10 });
    expect(res.people).toHaveLength(10);
  });
});

describe('GET /overview paging', () => {
  it('pages the departments list only, in name order, with departmentsMeta', async () => {
    const { svc } = setup();
    const departments = ['Coding', 'Billing', 'Admin'].map((name, i) => ({ id: `d${i}`, name }));
    const full = {
      today: { people: 25 },
      departments: [...departments].sort((a, b) => a.name.localeCompare(b.name)),
      attention: [{ kind: 'NO_AGENT', count: 25, people: [] }],
      nextHolidays: [{ date: '2026-12-25', label: 'Christmas' }],
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, working: 1 })),
    };
    jest.spyOn(svc as never, 'buildOverview').mockResolvedValue(full as never);

    const res = (await svc.overview(admin, NOW, {
      page: '2',
      limit: '2',
    })) as unknown as typeof full & {
      departmentsMeta: unknown;
    };
    expect(res.departments.map((d) => d.name)).toEqual(['Coding']);
    expect(res.departmentsMeta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(res.today).toEqual(full.today);
    expect(res.attention).toEqual(full.attention);
    expect(res.nextHolidays).toEqual(full.nextHolidays);
    expect(res.hourly).toHaveLength(24);
  });
});
