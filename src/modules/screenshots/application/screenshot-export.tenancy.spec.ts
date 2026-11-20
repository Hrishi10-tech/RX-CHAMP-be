import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ScreenshotExportService } from './screenshot-export.service';

/**
 * 4.0 tenancy for the 3.2 screenshot reports, monthly archives and deletion: an
 * organisation's admin archives and deletes its own month only; a report needs the
 * same right as viewing the screenshots; a job is seen by whoever started it or the
 * admins of its organisation.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-20T06:00:00Z');

const actor = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}) =>
  ({
    id,
    role,
    companyId: role === Role.SUPER_ADMIN ? null : ORG,
    orgId: ORG,
    departmentId: null,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    grants:
      role === Role.MANAGER ? { screenshots: true, timeline: true, activity: true } : undefined,
    ...over,
  }) as unknown as AuthenticatedUser;

const PEOPLE: Record<
  string,
  { id: string; role: string; companyId: string; departmentId: string }
> = {
  staff: { id: 'staff', role: 'USER', companyId: ORG, departmentId: 'd1' },
  other: { id: 'other', role: 'USER', companyId: ORG, departmentId: 'd2' },
  far: { id: 'far', role: 'USER', companyId: OTHER, departmentId: 'dx' },
};

function setup() {
  const jobs = {
    findActive: jest.fn().mockResolvedValue(null),
    countShots: jest.fn().mockResolvedValue(3),
    create: jest.fn(async (d: Record<string, unknown>) => ({
      id: 'job-1',
      status: 'QUEUED',
      done: 0,
      missing: 0,
      bytes: 0,
      complete: false,
      cancelRequested: false,
      createdAt: NOW,
      lastSeenAt: NOW,
      ...d,
    })),
    listForMonth: jest.fn().mockResolvedValue([]),
    countByMonth: jest.fn().mockResolvedValue([]),
    listRecent: jest.fn().mockResolvedValue([]),
    find: jest.fn(),
    claimNext: jest.fn().mockResolvedValue(null),
  };
  const facts = { find: jest.fn(async (id: string) => PEOPLE[id] ?? null) };
  const config = { get: jest.fn().mockReturnValue(7) };
  const svc = new ScreenshotExportService(
    jobs as never,
    facts as never,
    {} as never,
    config as never,
  );
  // The worker is not under test here.
  jest.spyOn(svc, 'tick').mockResolvedValue(undefined);
  return { svc, jobs };
}

describe('ScreenshotExportService: organisations (4.0)', () => {
  it("an Admin archives their own organisation's month, and only it is counted", async () => {
    const { svc, jobs } = setup();
    await svc.startArchive(actor('admin', Role.ADMIN), '2026-10', NOW);
    expect(jobs.findActive).toHaveBeenCalledWith({ month: '2026-10', companyId: ORG });
    expect(jobs.countShots).toHaveBeenCalledWith(expect.objectContaining({ companyId: ORG }));
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'MONTH_ARCHIVE', companyId: ORG, month: '2026-10' }),
    );
  });

  it('a Manager or a Super Manager may not archive, delete or list the months (403)', async () => {
    const { svc, jobs } = setup();
    for (const me of [actor('mgr', Role.MANAGER), actor('sm', Role.SUPER_MANAGER)]) {
      await expect(svc.startArchive(me, '2026-10', NOW)).rejects.toMatchObject({ status: 403 });
      await expect(svc.startPurge(me, '2026-10', NOW)).rejects.toMatchObject({ status: 403 });
      await expect(svc.months(me, NOW)).rejects.toMatchObject({ status: 403 });
    }
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('the month list and the nudge read only the organisation in view', async () => {
    const { svc, jobs } = setup();
    await svc.months(actor('admin', Role.ADMIN), NOW);
    expect(jobs.countByMonth).toHaveBeenCalledWith(expect.any(String), expect.any(Date), ORG);
    expect(jobs.listRecent).toHaveBeenCalledWith(null, 100, ORG);
    await svc.nudge(actor('admin', Role.ADMIN), NOW);
    expect(jobs.countByMonth).toHaveBeenLastCalledWith(expect.any(String), expect.any(Date), ORG);
    // A Super Admin on "All organisations" gets no nudge.
    await expect(
      svc.nudge(actor('sa', Role.SUPER_ADMIN, { orgId: null }), NOW),
    ).resolves.toBeNull();
  });

  it('a report needs the right to see the screenshots', async () => {
    const { svc } = setup();
    const period = { userId: 'staff', mode: 'DAY', date: '2026-11-02' };
    // A Manager of the department, with the grant.
    await expect(
      svc.startReport(actor('mgr', Role.MANAGER), period as never, NOW),
    ).resolves.toBeDefined();
    // Not for Staff of another department, nor across organisations.
    await expect(
      svc.startReport(actor('mgr', Role.MANAGER), { ...period, userId: 'other' } as never, NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.startReport(actor('admin', Role.ADMIN), { ...period, userId: 'far' } as never, NOW),
    ).rejects.toMatchObject({ status: 404 });
    // Not without the screenshots grant.
    const noGrant = actor('mgr', Role.MANAGER, {
      grants: { screenshots: false, timeline: true, activity: true },
    } as never);
    await expect(svc.startReport(noGrant, period as never, NOW)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a job is someone else's unless they are an admin of its organisation", async () => {
    const { svc, jobs } = setup();
    const job = {
      id: 'job-9',
      kind: 'MONTH_ARCHIVE',
      status: 'DONE',
      requestedById: 'admin-2',
      companyId: ORG,
      done: 1,
      total: 1,
      missing: 0,
      bytes: 10,
      complete: true,
      cancelRequested: false,
      createdAt: NOW,
      lastSeenAt: NOW,
    };
    jobs.find.mockResolvedValue(job);
    await expect(svc.view(actor('admin', Role.ADMIN), 'job-9', NOW)).resolves.toBeDefined();
    await expect(
      svc.view(actor('admin-x', Role.ADMIN, { companyId: OTHER, orgId: OTHER }), 'job-9', NOW),
    ).rejects.toMatchObject({ status: 403 });
    await expect(svc.view(actor('mgr', Role.MANAGER), 'job-9', NOW)).rejects.toMatchObject({
      status: 403,
    });
  });
});
