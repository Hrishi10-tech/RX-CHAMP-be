import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { AgentController } from './agent.controller';

/**
 * 4.0 (audit L5, docs/4.0/SPEC.md 5.3): a setup code (and a per-user installer)
 * carries a 365-day enrollment token, so only an Admin or Super Admin may mint one,
 * for people they may change, never for themselves.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const person = (id: string, role: Role, companyId = ORG, departmentId: string | null = 'd1') => ({
  id,
  role,
  companyId,
  departmentId,
  enrollVersion: 3,
});
const PEOPLE = [
  person('staff', Role.USER),
  person('mgr', Role.MANAGER, ORG, null),
  person('admin', Role.ADMIN, ORG, null),
  person('far', Role.USER, OTHER, 'dx'),
];

const actor = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}) =>
  ({
    id,
    role,
    companyId: role === Role.SUPER_ADMIN ? null : ORG,
    orgId: ORG,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    grants:
      role === Role.MANAGER ? { screenshots: true, timeline: true, activity: true } : undefined,
    ...over,
  }) as unknown as AuthenticatedUser;

function setup(stores: unknown = {}) {
  const config = {
    get: jest.fn((k: string) =>
      k === 'agent.publicApiBaseUrl' ? 'https://api.test/api/v1' : undefined,
    ),
  };
  const tokens = {
    signEnrollmentToken: jest.fn(async (id: string, v: number) => `token-${id}-${v}`),
  };
  const users = {
    findById: jest.fn(async (id: string) => PEOPLE.find((p) => p.id === id) ?? null),
  };
  const audit = { record: jest.fn() };
  const controller = new AgentController(
    config as never,
    tokens as never,
    users as never,
    stores as never,
    audit as never,
  );
  return { controller, tokens };
}

describe('GET /agent/setup-code (4.0)', () => {
  it('an Admin mints one for their Staff and Managers', async () => {
    const { controller, tokens } = setup();
    const res = (await controller.setupCode(actor('admin', Role.ADMIN), 'staff')) as unknown as {
      data: { code: string };
    };
    expect(res.data.code).toMatch(/^RXV1\./);
    await controller.setupCode(actor('admin', Role.ADMIN), 'mgr');
    expect(tokens.signEnrollmentToken).toHaveBeenCalledTimes(2);
  });

  it('a Super Admin also for the Admin', async () => {
    const { controller } = setup();
    await expect(
      controller.setupCode(actor('sa', Role.SUPER_ADMIN), 'admin'),
    ).resolves.toBeDefined();
  });

  it('nobody for themselves: Staff, a Manager, an Admin (403); no token minted', async () => {
    const { controller, tokens } = setup();
    for (const [id, role] of [
      ['staff', Role.USER],
      ['mgr', Role.MANAGER],
      ['admin', Role.ADMIN],
    ] as const) {
      await expect(controller.setupCode(actor(id, role), id)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(tokens.signEnrollmentToken).not.toHaveBeenCalled();
  });

  it('a Manager not for their Staff (403); Staff not for anyone else (404); nobody across organisations (404)', async () => {
    const { controller, tokens } = setup();
    await expect(controller.setupCode(actor('mgr', Role.MANAGER), 'staff')).rejects.toMatchObject({
      status: 403,
    });
    await expect(controller.setupCode(actor('staff', Role.USER), 'mgr')).rejects.toMatchObject({
      status: 404,
    });
    await expect(controller.setupCode(actor('admin', Role.ADMIN), 'far')).rejects.toMatchObject({
      status: 404,
    });
    expect(tokens.signEnrollmentToken).not.toHaveBeenCalled();
  });
});

describe('POST /agent/download-ticket + GET /agent/download/direct (direct download)', () => {
  const available = { windows: { info: jest.fn(async () => ({ available: true })) } };
  const urlOf = (r: unknown) => (r as { data: { url: string } }).data.url;
  const ticketOf = (url: string) => new URL(url).searchParams.get('ticket')!;

  it('returns a link on the public API host', async () => {
    const { controller } = setup(available);
    const url = urlOf(await controller.downloadTicket(actor('admin', Role.ADMIN)));
    expect(url.startsWith('https://api.test/api/v1/agent/download/direct?ticket=')).toBe(true);
  });

  it('checks per-user access before issuing (Admin not across organisations: 404)', async () => {
    const { controller } = setup(available);
    await expect(
      controller.downloadTicket(actor('admin', Role.ADMIN), 'far'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when the agent is not uploaded (404)', async () => {
    const { controller } = setup({
      windows: { info: jest.fn(async () => ({ available: false })) },
    });
    await expect(controller.downloadTicket(actor('admin', Role.ADMIN))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a ticket works once; a second use or a made-up one is 403', async () => {
    const { controller } = setup(available);
    const serve = jest
      .spyOn(controller as unknown as { serve: () => Promise<void> }, 'serve')
      .mockResolvedValue(undefined);
    const me = actor('admin', Role.ADMIN);
    const ticket = ticketOf(urlOf(await controller.downloadTicket(me, 'staff')));
    await controller.downloadDirect({} as never, ticket);
    expect(serve).toHaveBeenCalledWith(me, {}, 'staff', 'windows');
    await expect(controller.downloadDirect({} as never, ticket)).rejects.toMatchObject({
      status: 403,
    });
    await expect(controller.downloadDirect({} as never, 'nope')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('an expired ticket is 403', async () => {
    const { controller } = setup(available);
    jest
      .spyOn(controller as unknown as { serve: () => Promise<void> }, 'serve')
      .mockResolvedValue();
    const ticket = ticketOf(urlOf(await controller.downloadTicket(actor('admin', Role.ADMIN))));
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(controller.downloadDirect({} as never, ticket)).rejects.toMatchObject({
      status: 403,
    });
    jest.restoreAllMocks();
  });
});
