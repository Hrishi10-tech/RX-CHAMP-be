import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { FocusAdjustmentRecord } from '../domain/focus-adjustment';
import { NOTICE } from '../domain/notice-copy';
import { FocusAdjustmentsService } from './focus-adjustments.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

// 15:00 IST on 3 Nov 2026.
const NOW = new Date('2026-11-03T09:30:00Z');

/** A caller acting in organisation c1 (the Super Manager and Super Admin: picked with X-Org-Id). */
const me = (role: Role, id = 'me', orgId: string | null = 'c1'): AuthenticatedUser => ({
  id,
  email: `${id}@x.test`,
  role,
  permissions: [],
  department: null,
  companyId: role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER ? null : 'c1',
  orgId,
  status: 'ACTIVE' as AuthenticatedUser['status'],
  managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
});

const NAMES: Record<string, [string, string, string | null]> = {
  asha: ['Asha', 'Rao', 'RhythmRx'],
  ravi: ['Ravi', 'Shankar', 'RhythmRx'],
  omar: ['Omar', 'Khan', 'Other Org'],
  sm: ['Sara', 'Menon', null],
};

const person = (id: string, over: Partial<ShiftPerson> = {}): ShiftPerson => ({
  id,
  firstName: NAMES[id]?.[0] ?? id,
  lastName: NAMES[id]?.[1] ?? '',
  email: `${id}@x.test`,
  role: 'USER',
  department: 'Billing',
  designation: null,
  companyId: 'c1',
  departmentId: 'd1',
  managerId: null,
  active: true,
  ...over,
});

const PEOPLE: Record<string, ShiftPerson> = {
  asha: person('asha'),
  ravi: person('ravi'),
  omar: person('omar', { companyId: 'c2', departmentId: 'd9' }),
  root: person('root', { role: 'SUPER_ADMIN', companyId: 'c1' }),
  sm: person('sm', { role: 'SUPER_MANAGER', companyId: null, departmentId: null }),
};

const record = (over: Partial<FocusAdjustmentRecord> = {}): FocusAdjustmentRecord => ({
  id: 'a1',
  userId: 'asha',
  date: '2026-11-02',
  deltaSec: 30 * 60,
  reason: 'Agent missed Start Day until 10:00',
  createdById: 'sm',
  createdAt: NOW,
  voidedAt: null,
  voidedById: null,
  ...over,
});

function setup(opts: { enabled?: boolean | Record<string, boolean> } = {}) {
  const repo = {
    listForUsersBetween: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    create: jest
      .fn()
      .mockImplementation(async (data, now: Date) => record({ ...data, createdAt: now })),
    void: jest
      .fn()
      .mockImplementation(async (id: string, byId: string, now: Date) =>
        record({ id, voidedAt: now, voidedById: byId }),
      ),
    namesOf: jest.fn().mockImplementation(async (ids: string[]) =>
      ids
        .filter((id) => NAMES[id])
        .map((id) => ({
          id,
          firstName: NAMES[id][0],
          lastName: NAMES[id][1],
          companyName: NAMES[id][2],
        })),
    ),
  };
  const people = {
    findById: jest.fn().mockImplementation(async (id: string) => PEOPLE[id] ?? null),
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined) };
  const enabledFor = (companyId: string | null) =>
    typeof opts.enabled === 'object'
      ? (opts.enabled[companyId ?? ''] ?? true)
      : (opts.enabled ?? true);
  const settings = {
    get: jest.fn(async (companyId: string | null) => ({
      focusAdjustmentsEnabled: enabledFor(companyId),
    })),
  };
  const scope = {
    assertManagerOrAdmin: jest.fn((u: AuthenticatedUser) => {
      if (u.role === Role.USER) throw new AppException(403, 'FORBIDDEN', 'no');
    }),
    scope: jest.fn().mockResolvedValue([{ id: 'asha' }]),
  };
  const service = new FocusAdjustmentsService(
    repo as never,
    people as never,
    events as never,
    settings as never,
    scope as never,
  );
  return { service, repo, people, events, settings, scope };
}

const failsWith = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = (await p.catch((e) => e)) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.status).toBe(status);
  if (code) expect(err.code).toBe(code);
  return err;
};

const SM = me(Role.SUPER_MANAGER, 'sm');

describe('FocusAdjustmentsService.create', () => {
  const input = {
    userId: 'asha',
    date: '2026-11-02',
    minutes: 30,
    reason: 'Agent missed Start Day until 10:00',
  };

  it('lets the Super Manager add minutes, tells the person, returns the view', async () => {
    const { service, repo, events } = setup();
    const view = await service.create(SM, input, NOW);
    expect(repo.create).toHaveBeenCalledWith(
      {
        userId: 'asha',
        date: '2026-11-02',
        deltaSec: 1800,
        reason: input.reason,
        createdById: 'sm',
      },
      NOW,
    );
    expect(view).toMatchObject({
      userId: 'asha',
      userName: 'Asha Rao',
      companyName: 'RhythmRx',
      deltaSec: 1800,
      label: '+30 min',
      createdByName: 'Sara Menon',
      voidedAt: null,
      voidedByName: null,
    });
    expect(events.publish).toHaveBeenCalledTimes(1);
    const notice = events.publish.mock.calls[0][1];
    expect(notice.recipientIds).toEqual(['asha']);
    expect(notice.type).toBe(NOTICE.FOCUS_ADJUSTED);
    expect(notice.fromUserId).toBe('sm');
    expect(notice.body).toContain('30 minutes');
    expect(notice.body).toContain(input.reason);
  });

  it('refuses everyone but the Super Manager, even the Super Admin and the Admin', async () => {
    const { service, repo } = setup();
    for (const role of [Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER, Role.USER]) {
      await failsWith(service.create(me(role), input, NOW), 403);
    }
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("is off when the person's organisation switched the setting off (per organisation)", async () => {
    const { service, repo, settings } = setup({ enabled: { c1: false } });
    await failsWith(service.create(SM, input, NOW), 409, 'ADJUSTMENTS_OFF');
    expect(settings.get).toHaveBeenCalledWith('c1');
    expect(repo.create).not.toHaveBeenCalled();
    // Another organisation keeps them (the Super Manager with "All organisations").
    await service.create(me(Role.SUPER_MANAGER, 'sm', null), { ...input, userId: 'omar' }, NOW);
    expect(settings.get).toHaveBeenLastCalledWith('c2');
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('never adjusts its own day', async () => {
    const { service } = setup();
    await failsWith(service.create(SM, { ...input, userId: 'sm' }, NOW), 403);
  });

  it('404s an unknown person, a Super Admin, and anyone outside the organisation in view', async () => {
    const { service, repo } = setup();
    await failsWith(service.create(SM, { ...input, userId: 'ghost' }, NOW), 404);
    await failsWith(service.create(SM, { ...input, userId: 'root' }, NOW), 404);
    await failsWith(service.create(SM, { ...input, userId: 'omar' }, NOW), 404);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('404s an X-Org-Id that names no organisation', async () => {
    const { service } = setup();
    await failsWith(
      service.create({ ...SM, orgHeaderInvalid: true }, input, NOW),
      404,
      'ORG_NOT_FOUND',
    );
  });

  it('validates minutes, reason and date, naming the field', async () => {
    const { service, repo } = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ minutes: 0 }, 'minutes'],
      [{ minutes: 1.5 }, 'minutes'],
      [{ minutes: '30' }, 'minutes'],
      [{ minutes: 721 }, 'minutes'],
      [{ minutes: -721 }, 'minutes'],
      [{ reason: 'ok' }, 'reason'],
      [{ reason: 'x'.repeat(301) }, 'reason'],
      [{ date: '2026-11-04' }, 'date'],
      [{ date: '2026-09-01' }, 'date'],
    ];
    for (const [over, field] of cases) {
      const err = await failsWith(service.create(SM, { ...input, ...over }, NOW), 400);
      expect(err.details).toEqual({ field });
    }
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('accepts the limits exactly and normalises the reason', async () => {
    const { service, repo } = setup();
    await service.create(
      SM,
      { ...input, minutes: -720, reason: '  double  spaced   reason ' },
      NOW,
    );
    expect(repo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ deltaSec: -720 * 60, reason: 'double spaced reason' }),
      NOW,
    );
    await service.create(SM, { ...input, date: '2026-09-02' }, NOW);
    await service.create(SM, { ...input, date: '2026-11-03' }, NOW);
    expect(repo.create).toHaveBeenCalledTimes(3);
  });

  it('passes a locked month on as 409 MONTH_LOCKED and tells nobody', async () => {
    const { service, repo, events } = setup();
    repo.create.mockRejectedValueOnce(new AppException(409, 'MONTH_LOCKED', 'locked'));
    await failsWith(service.create(SM, input, NOW), 409, 'MONTH_LOCKED');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('still saves when the notification fails', async () => {
    const { service, events } = setup();
    events.publish.mockRejectedValueOnce(new Error('bus down'));
    await expect(service.create(SM, input, NOW)).resolves.toMatchObject({ label: '+30 min' });
  });
});

describe('FocusAdjustmentsService.void', () => {
  it('voids once, tells the person, and refuses a second time', async () => {
    const { service, repo, events } = setup();
    repo.findById.mockResolvedValueOnce(record());
    const view = await service.void(SM, 'a1', NOW);
    expect(repo.void).toHaveBeenCalledWith('a1', 'sm', NOW);
    expect(view.voidedAt).toBe(NOW.toISOString());
    expect(view.voidedByName).toBe('Sara Menon');
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish.mock.calls[0][1].title).toMatch(/undone/);
    expect(events.publish.mock.calls[0][1].recipientIds).toEqual(['asha']);

    repo.findById.mockResolvedValueOnce(record({ voidedAt: NOW, voidedById: 'sm' }));
    await failsWith(service.void(SM, 'a1', NOW), 409, 'ALREADY_VOID');
  });

  it('is the Super Manager’s alone and 404s an unknown id', async () => {
    const { service } = setup();
    await failsWith(service.void(me(Role.SUPER_ADMIN), 'a1', NOW), 403);
    await failsWith(service.void(me(Role.ADMIN), 'a1', NOW), 403);
    await failsWith(service.void(SM, 'nope', NOW), 404);
  });

  it('404s an adjustment of someone outside the organisation in view', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValueOnce(record({ userId: 'omar' }));
    await failsWith(service.void(SM, 'a1', NOW), 404);
    expect(repo.void).not.toHaveBeenCalled();
  });

  it('is off, too, while the organisation has adjustments switched off', async () => {
    const { service, repo } = setup({ enabled: false });
    repo.findById.mockResolvedValueOnce(record());
    await failsWith(service.void(SM, 'a1', NOW), 409, 'ADJUSTMENTS_OFF');
    expect(repo.void).not.toHaveBeenCalled();
  });
});

describe('FocusAdjustmentsService.list', () => {
  it('shows the Super Manager and Super Admin the organisation in view', async () => {
    const { service, repo } = setup();
    await service.list(SM, { month: '2026-11', companyId: 'c2' }, NOW);
    expect(repo.list).toHaveBeenLastCalledWith({
      userId: undefined,
      userIds: undefined,
      month: '2026-11',
      companyId: 'c1',
      includeVoided: true,
      limit: undefined,
    });
    await service.list(me(Role.SUPER_ADMIN), { userId: 'ravi' }, NOW);
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'ravi', userIds: undefined, companyId: 'c1' }),
    );
  });

  it('with "All organisations" shows every one, or the organisation asked for', async () => {
    const { service, repo } = setup();
    await service.list(me(Role.SUPER_MANAGER, 'sm', null), {}, NOW);
    expect(repo.list).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: undefined }));
    await service.list(me(Role.SUPER_ADMIN, 'root', null), { companyId: 'c2' }, NOW);
    expect(repo.list).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'c2' }));
  });

  it('keeps the Admin to their own organisation whatever they ask for', async () => {
    const { service, repo } = setup();
    await service.list(me(Role.ADMIN, 'adm'), { companyId: 'c2' }, NOW);
    expect(repo.list).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'c1' }));
  });

  it("limits a Manager to their departments' Staff and ignores an organisation filter", async () => {
    const { service, repo, scope } = setup();
    await service.list(me(Role.MANAGER, 'm1'), { companyId: 'c2' }, NOW);
    expect(scope.scope).toHaveBeenCalled();
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ userIds: ['asha'], companyId: undefined }),
    );
    expect(await service.list(me(Role.MANAGER, 'm1'), { userId: 'ravi' }, NOW)).toEqual([]);
  });

  it('keeps staff out, and gives them only their own live ones through mine()', async () => {
    const { service, repo } = setup();
    await failsWith(service.list(me(Role.USER, 'asha'), {}, NOW), 403);
    repo.list.mockResolvedValueOnce([record()]);
    const mine = await service.mine(me(Role.USER, 'asha'), '2026-11');
    expect(repo.list).toHaveBeenLastCalledWith({
      userId: 'asha',
      month: '2026-11',
      includeVoided: false,
      limit: 100,
    });
    expect(mine[0]).toMatchObject({ label: '+30 min', createdByName: 'Sara Menon' });
  });

  it('names a former user when the account is gone', async () => {
    const { service, repo } = setup();
    repo.list.mockResolvedValueOnce([record({ userId: 'gone', createdById: 'gone-too' })]);
    const [view] = await service.list(SM, {}, NOW);
    expect(view.userName).toBe('Former user');
    expect(view.createdByName).toBe('Former user');
    expect(view.companyName).toBeNull();
  });
});
