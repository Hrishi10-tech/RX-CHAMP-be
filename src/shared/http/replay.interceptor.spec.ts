import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { defer, lastValueFrom, Observable } from 'rxjs';
import { ConflictError, ValidationError } from '@shared/exceptions/app.exception';
import { RequestClock } from '@shared/tenancy';
import { ReplayedResponse } from './all-exceptions.filter';
import { ReplayInterceptor } from './replay.interceptor';

/**
 * 4.0 offline replay (docs/4.0/SPEC.md 6) without a database: agent_events,
 * work_sessions and work_day_ends are small in-memory fakes behind a mocked
 * PrismaService, and the controller is a fake CallHandler.
 */

const NOW = new Date('2026-10-20T10:00:00.000Z');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EV1 = '0b5c1f3e-7f7a-4c1e-9d0e-3a3e0f1d2c01';
const EV2 = '0b5c1f3e-7f7a-4c1e-9d0e-3a3e0f1d2c02';
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface StoredEvent {
  userId: string;
  clientEventId: string;
  kind: string;
  eventAt: Date;
  receivedAt: Date;
  status: number;
  body: unknown;
}

interface Session {
  id: string;
  date: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  source?: string;
}

function fakePrisma() {
  const events = new Map<string, StoredEvent>();
  const key = (u: string, e: string) => `${u}:${e}`;
  const sessions: Session[] = [];
  const dayEnds = new Map<string, { endedAt: Date | null }>();

  const monthLocks = new Set<string>();
  const prisma = {
    events,
    sessions,
    dayEnds,
    monthLocks,
    monthLock: {
      findUnique: jest.fn(
        async ({ where }: { where: { companyId_month: { companyId: string; month: string } } }) => {
          const k = where.companyId_month;
          return monthLocks.has(`${k.companyId}:${k.month}`) ? { month: k.month } : null;
        },
      ),
    },
    agentEvent: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_clientEventId;
        return events.get(key(k.userId, k.clientEventId)) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const k = key(data.userId, data.clientEventId);
        if (events.has(k)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { ...data, receivedAt: new Date() };
        events.set(k, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const k = where.userId_clientEventId;
        const row = events.get(key(k.userId, k.clientEventId));
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const k = key(where.userId, where.clientEventId);
        const row = events.get(k);
        if (row && (where.status === undefined || row.status === where.status)) {
          events.delete(k);
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const rows = [...events.values()]
          .filter((r) => r.userId === where.userId && r.status !== where.status.not)
          .filter((r) => !where.kind?.in || where.kind.in.includes(r.kind))
          .sort((a, b) => b.eventAt.getTime() - a.eventAt.getTime());
        return rows[0] ? { eventAt: rows[0].eventAt } : null;
      }),
    },
    workSession: {
      findFirst: jest.fn(async () => {
        const sorted = [...sessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        return sorted[0] ?? null;
      }),
      count: jest.fn(async () => sessions.filter((s) => s.endedAt === null).length),
      update: jest.fn(({ where, data }: any) => ({ op: 'workSession.update', where, data })),
    },
    workDayEnd: {
      findUnique: jest.fn(async ({ where }: any) => dayEnds.get(where.userId_date.date) ?? null),
      update: jest.fn(({ where, data }: any) => ({ op: 'workDayEnd.update', where, data })),
    },
    $transaction: jest.fn(async (ops: any[]) => {
      for (const op of ops) {
        if (op.op === 'workSession.update')
          Object.assign(sessions.find((s) => s.id === op.where.id)!, op.data);
        if (op.op === 'workDayEnd.update')
          Object.assign(dayEnds.get(op.where.userId_date.date)!, op.data);
      }
      return ops;
    }),
  };
  return prisma;
}

type Req = {
  method: string;
  headers: Record<string, string | string[]>;
  user?: { id: string; companyId?: string };
  route?: { path: string };
  path: string;
};

const AGENT_40 = 'RXVisionAgent/4.0.0 (Windows)';

/** A request from the 4.0 agent to End break (an action replayed at its event time) unless told otherwise. */
function request(
  headers: Record<string, string | string[]> = {},
  method = 'POST',
  opts: { route?: string; ua?: string | null } = {},
): Req {
  const route = opts.route ?? '/api/v1/breaks/end';
  const ua = opts.ua === undefined ? AGENT_40 : opts.ua;
  return {
    method,
    headers: { ...(ua ? { 'user-agent': ua } : {}), ...headers },
    user: { id: USER },
    route: { path: route },
    path: route,
  };
}

function context(req: Req, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** A controller that records the clock it saw and answers `result()` (or throws). */
function handler(result: () => unknown = () => ({ success: true, data: { ok: true } })) {
  const seen: { now: Date; replay: boolean }[] = [];
  const h: CallHandler = {
    handle: () =>
      defer(async () => {
        // An await inside the handler, as a service would do.
        await Promise.resolve();
        seen.push({ now: RequestClock.now(), replay: RequestClock.isReplay() });
        return result();
      }),
  };
  return { h, seen, calls: () => seen.length };
}

const headers = (eventId: string, at?: Date | string) => ({
  'x-client-event-id': eventId,
  ...(at ? { 'x-event-at': typeof at === 'string' ? at : at.toISOString() } : {}),
});

async function run(i: ReplayInterceptor, req: Req, h: CallHandler) {
  return lastValueFrom(i.intercept(context(req), h) as Observable<unknown>);
}

async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a failure');
}

describe('ReplayInterceptor', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let interceptor: ReplayInterceptor;
  /** The worktime module's answer: each day's latest end (shift end + allowance). */
  let latestEnd: Date;
  const limits = {
    latestEndOfSession: jest.fn(async () => latestEnd),
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    prisma = fakePrisma();
    latestEnd = new Date(NOW.getTime() + 10 * 60 * MIN);
    limits.latestEndOfSession.mockClear();
    interceptor = new ReplayInterceptor(prisma as never, { get: () => limits } as never);
  });
  afterEach(() => jest.useRealTimers());

  describe('pass-through', () => {
    it('without X-Client-Event-Id: the handler runs on the server clock and nothing is stored', async () => {
      const { h, seen } = handler();
      await expect(run(interceptor, request(), h)).resolves.toEqual({
        success: true,
        data: { ok: true },
      });
      expect(seen).toEqual([{ now: NOW, replay: false }]);
      expect(prisma.agentEvent.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentEvent.create).not.toHaveBeenCalled();
    });

    it('for a GET even with the headers', async () => {
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(60 * MIN)), 'GET'), h);
      await run(interceptor, request(headers(EV1, ago(60 * MIN)), 'GET'), h);
      expect(calls()).toBe(2);
      expect(prisma.agentEvent.findUnique).not.toHaveBeenCalled();
    });

    it('without a signed-in person, or outside HTTP', async () => {
      const { h, calls } = handler();
      const anon = { ...request(headers(EV1, ago(60 * MIN))), user: undefined };
      await run(interceptor, anon, h);
      await lastValueFrom(
        interceptor.intercept(context(request(headers(EV1)), 'ws'), h) as Observable<unknown>,
      );
      expect(calls()).toBe(2);
      expect(prisma.agentEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('header validation', () => {
    it('refuses an event id that is not a UUID (400)', async () => {
      const { h, calls } = handler();
      const err = await failure(run(interceptor, request(headers('not-a-uuid')), h));
      expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(calls()).toBe(0);
    });

    it('refuses an X-Event-At that is not a time (422 EVENT_TIME_INVALID)', async () => {
      const { h, calls } = handler();
      const err = await failure(run(interceptor, request(headers(EV1, 'yesterday-ish')), h));
      expect(err).toMatchObject({ status: 422, code: 'EVENT_TIME_INVALID' });
      expect(calls()).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('stores a success and answers the same body for a repeat without running the handler again', async () => {
      const body = { success: true, data: { id: 'brk-1', state: 'ENDED' } };
      const { h, calls } = handler(() => body);
      await expect(run(interceptor, request(headers(EV1, ago(5 * MIN))), h)).resolves.toEqual(body);
      expect(prisma.agentEvent.create).toHaveBeenCalledWith({
        data: {
          userId: USER,
          clientEventId: EV1,
          kind: 'POST /api/v1/breaks/end',
          eventAt: ago(5 * MIN),
          status: 0,
          body: {},
        },
      });
      expect(prisma.events.get(`${USER}:${EV1}`)).toMatchObject({ status: 200, body });

      const err = await failure(run(interceptor, request(headers(EV1, ago(5 * MIN))), h));
      expect(err).toBeInstanceOf(ReplayedResponse);
      expect(err).toMatchObject({ status: 200, body });
      expect(calls()).toBe(1);
    });

    it('stores a 4xx refusal and repeats it as a ReplayedResponse', async () => {
      const { h, calls } = handler(() => {
        throw new ConflictError('You are already on a break.', 'ON_BREAK');
      });
      const first = await failure(run(interceptor, request(headers(EV1, ago(5 * MIN))), h));
      expect(first).toBeInstanceOf(ConflictError);
      const stored = prisma.events.get(`${USER}:${EV1}`)!;
      expect(stored.status).toBe(409);
      expect(stored.body).toEqual({
        success: false,
        message: 'You are already on a break.',
        error: { code: 'ON_BREAK', message: 'You are already on a break.' },
      });

      const repeat = await failure(run(interceptor, request(headers(EV1, ago(5 * MIN))), h));
      expect(repeat).toBeInstanceOf(ReplayedResponse);
      expect(repeat).toMatchObject({ status: 409, body: stored.body });
      expect(calls()).toBe(1);
    });

    it('does not store a 5xx: the placeholder is removed and a retry runs the handler again', async () => {
      let fail = true;
      const { h, calls } = handler(() => {
        if (fail) throw new Error('database went away');
        return { success: true, data: 'second time lucky' };
      });
      const first = await failure(run(interceptor, request(headers(EV1, ago(5 * MIN))), h));
      expect(first.message).toBe('database went away');
      expect(prisma.events.has(`${USER}:${EV1}`)).toBe(false);

      fail = false;
      await expect(run(interceptor, request(headers(EV1, ago(5 * MIN))), h)).resolves.toEqual({
        success: true,
        data: 'second time lucky',
      });
      expect(calls()).toBe(2);
      expect(prisma.events.get(`${USER}:${EV1}`)?.status).toBe(200);
    });

    it('keys events per person: the same event id from someone else is a different event', async () => {
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(5 * MIN))), h);
      const other = {
        ...request(headers(EV1, ago(5 * MIN))),
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      };
      await run(interceptor, other, h);
      expect(calls()).toBe(2);
    });
  });

  describe('in-progress placeholders', () => {
    const placeholder = (receivedAt: Date): StoredEvent => ({
      userId: USER,
      clientEventId: EV1,
      kind: 'POST /api/v1/breaks/end',
      eventAt: ago(10 * MIN),
      receivedAt,
      status: 0,
      body: {},
    });

    it('a fresh placeholder answers 409 EVENT_IN_PROGRESS and the handler does not run', async () => {
      prisma.events.set(`${USER}:${EV1}`, placeholder(ago(MIN)));
      const { h, calls } = handler();
      const err = await failure(run(interceptor, request(headers(EV1, ago(10 * MIN))), h));
      expect(err).toBeInstanceOf(ReplayedResponse);
      expect(err.status).toBe(409);
      expect(err.body).toMatchObject({ success: false, error: { code: 'EVENT_IN_PROGRESS' } });
      expect(calls()).toBe(0);
      // The placeholder is left for the running request.
      expect(prisma.events.get(`${USER}:${EV1}`)?.status).toBe(0);
    });

    it('a stale placeholder (a crashed request) is removed and the event runs again', async () => {
      prisma.events.set(`${USER}:${EV1}`, placeholder(ago(3 * MIN)));
      const { h, calls } = handler();
      await expect(run(interceptor, request(headers(EV1, ago(10 * MIN))), h)).resolves.toEqual({
        success: true,
        data: { ok: true },
      });
      expect(prisma.agentEvent.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, clientEventId: EV1, status: 0 },
      });
      expect(calls()).toBe(1);
      expect(prisma.events.get(`${USER}:${EV1}`)?.status).toBe(200);
    });

    it('two copies racing to create the event: the loser answers 409 EVENT_IN_PROGRESS', async () => {
      prisma.agentEvent.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      const { h, calls } = handler();
      const err = await failure(run(interceptor, request(headers(EV1, ago(10 * MIN))), h));
      expect(err).toBeInstanceOf(ReplayedResponse);
      expect(err.status).toBe(409);
      expect(err.body).toMatchObject({ error: { code: 'EVENT_IN_PROGRESS' } });
      expect(calls()).toBe(0);
    });
  });

  describe('event time (X-Event-At)', () => {
    it('more than 10 minutes ahead: 422 EVENT_TIME_INVALID, nothing stored', async () => {
      const { h, calls } = handler();
      const err = await failure(
        run(interceptor, request(headers(EV1, new Date(NOW.getTime() + 10 * MIN + 1000))), h),
      );
      expect(err).toMatchObject({ status: 422, code: 'EVENT_TIME_INVALID' });
      expect(calls()).toBe(0);
      expect(prisma.events.size).toBe(0);
    });

    it('ahead by less than 10 minutes: treated as now (a live action on the server clock)', async () => {
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, new Date(NOW.getTime() + 9 * MIN))), h);
      expect(seen).toEqual([{ now: NOW, replay: false }]);
      expect(prisma.events.get(`${USER}:${EV1}`)?.eventAt).toEqual(NOW);
    });

    it('more than 7 days old: 422 EVENT_TIME_INVALID', async () => {
      const { h, calls } = handler();
      const err = await failure(
        run(interceptor, request(headers(EV1, ago(7 * 24 * 60 * MIN + 1000))), h),
      );
      expect(err).toMatchObject({ status: 422, code: 'EVENT_TIME_INVALID' });
      expect(calls()).toBe(0);
      // Just inside 7 days is fine.
      await run(interceptor, request(headers(EV2, ago(7 * 24 * 60 * MIN - 1000))), h);
      expect(calls()).toBe(1);
    });

    it('older than the previous replayed event by more than 60 s: 422 EVENT_TIME_INVALID', async () => {
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(30 * MIN))), h);
      const err = await failure(run(interceptor, request(headers(EV2, ago(31 * MIN + 1000))), h));
      expect(err).toMatchObject({ status: 422, code: 'EVENT_TIME_INVALID' });
      expect(calls()).toBe(1);
      expect(prisma.events.has(`${USER}:${EV2}`)).toBe(false);
    });

    it('up to 60 s out of order is tolerated', async () => {
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(30 * MIN))), h);
      await run(interceptor, request(headers(EV2, ago(30 * MIN + 59_000))), h);
      expect(calls()).toBe(2);
    });

    it('a placeholder still in progress does not count as the previous event', async () => {
      prisma.events.set(`${USER}:other`, {
        userId: USER,
        clientEventId: 'other',
        kind: 'x',
        eventAt: ago(MIN),
        receivedAt: ago(MIN),
        status: 0,
        body: {},
      });
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(30 * MIN))), h);
      expect(calls()).toBe(1);
    });

    it('inside the handler, RequestClock.now() is the event time for a replay (> 30 s old)', async () => {
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, ago(45 * MIN))), h);
      expect(seen).toEqual([{ now: ago(45 * MIN), replay: true }]);
      // The clock goes back to the server time after the request.
      expect(RequestClock.now()).toEqual(NOW);
    });

    it('and the server time for a live action (30 s old or less), or without X-Event-At', async () => {
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, ago(20_000))), h);
      await run(interceptor, request(headers(EV2)), h);
      expect(seen).toEqual([
        { now: NOW, replay: false },
        { now: NOW, replay: false },
      ]);
      // A live action is still stored with its own time.
      expect(prisma.events.get(`${USER}:${EV1}`)?.eventAt).toEqual(ago(20_000));
      expect(prisma.events.get(`${USER}:${EV2}`)?.eventAt).toEqual(NOW);
    });
  });

  describe('event time only for replayed agent actions from a 4.0 agent', () => {
    const APPROVE = '/api/v1/approvals/:type/:id/approve';

    it('a route outside the agent actions runs at the server time; the event id still makes it idempotent', async () => {
      const body = { success: true, data: { status: 'APPROVED' } };
      const { h, seen, calls } = handler(() => body);
      const req = () => request(headers(EV1, ago(6 * 24 * 60 * MIN)), 'POST', { route: APPROVE });
      await expect(run(interceptor, req(), h)).resolves.toEqual(body);
      expect(seen).toEqual([{ now: NOW, replay: false }]);
      expect(prisma.events.get(`${USER}:${EV1}`)).toMatchObject({
        kind: `POST ${APPROVE}`,
        eventAt: NOW,
        status: 200,
      });
      const repeat = await failure(run(interceptor, req(), h));
      expect(repeat).toBeInstanceOf(ReplayedResponse);
      expect(repeat).toMatchObject({ status: 200, body });
      expect(calls()).toBe(1);
    });

    it('there, a bad or far-off X-Event-At is ignored rather than refused', async () => {
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, 'yesterday-ish'), 'POST', { route: APPROVE }), h);
      await run(
        interceptor,
        request(headers(EV2, ago(30 * 24 * 60 * MIN)), 'POST', { route: APPROVE }),
        h,
      );
      expect(seen).toEqual([
        { now: NOW, replay: false },
        { now: NOW, replay: false },
      ]);
    });

    it.each([
      ['a 3.1 agent', 'RXVisionAgent/3.1.0 (Windows)'],
      ['a 3.0 agent', 'RXVisionAgent/3.0.0 (Windows)'],
      ['curl (no agent)', 'curl/8.5.0'],
      ['no User-Agent', null],
    ])('an agent action from %s runs at the server time', async (_who, ua) => {
      const { h, seen } = handler();
      await run(
        interceptor,
        request(headers(EV1, ago(3 * 24 * 60 * MIN)), 'POST', {
          ua,
          route: '/api/v1/activity/start-day',
        }),
        h,
      );
      expect(seen).toEqual([{ now: NOW, replay: false }]);
      expect(prisma.events.get(`${USER}:${EV1}`)?.eventAt).toEqual(NOW);
    });

    it.each([
      '/api/v1/activity/start-day',
      '/api/v1/activity/end-day',
      '/api/v1/breaks/start',
      '/api/v1/breaks/quick/start',
      '/api/v1/breaks/:id/pause',
      '/api/v1/breaks/:id/resume',
      '/api/v1/breaks/skip',
      '/api/v1/breaks/:id/comment',
      '/api/v1/meetings/start',
      '/api/v1/meetings/past',
      '/api/v1/meetings/:id/end',
      '/api/v1/away',
      '/api/v1/away/unexplained',
      '/api/v1/presence/start',
      '/api/v1/presence/end',
    ])('the 4.0 agent replaying %s acts at its event time', async (route) => {
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, ago(45 * MIN)), 'POST', { route }), h);
      expect(seen).toEqual([{ now: ago(45 * MIN), replay: true }]);
    });

    it('the order check looks at replayed agent actions only', async () => {
      const { h, calls } = handler();
      // A request elsewhere with the headers, stored at the server time ...
      await run(interceptor, request(headers(EV1, ago(MIN)), 'POST', { route: APPROVE }), h);
      // ... does not make an older journal entry "out of order".
      await run(interceptor, request(headers(EV2, ago(30 * MIN))), h);
      expect(calls()).toBe(2);
      expect(prisma.events.get(`${USER}:${EV2}`)?.status).toBe(200);
    });
  });

  describe('a month locked for payroll', () => {
    const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const inOrg = (r: Req) => ({ ...r, user: { id: USER, companyId: ORG } });

    it('a replayed action dated in a locked month is refused (409 MONTH_LOCKED) before anything is written', async () => {
      prisma.monthLocks.add(`${ORG}:2026-10`);
      prisma.sessions.push({
        id: 'ws-1',
        date: '2026-10-20',
        startedAt: new Date('2026-10-20T04:00:00Z'),
        endedAt: new Date('2026-10-20T05:00:00Z'),
        endReason: 'AUTO_CLOSED',
      });
      const { h, calls } = handler();
      const err = await failure(
        run(interceptor, inOrg(request(headers(EV1, '2026-10-20T08:00:00.000Z'))), h),
      );
      expect(err).toMatchObject({ status: 409, code: 'MONTH_LOCKED' });
      expect(calls()).toBe(0);
      expect(prisma.agentEvent.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a month that is not locked, and a live action, run as usual', async () => {
      prisma.monthLocks.add(`${ORG}:2026-09`);
      const { h, calls } = handler();
      await run(interceptor, inOrg(request(headers(EV1, ago(2 * 60 * MIN)))), h);
      await run(interceptor, inOrg(request(headers(EV2, ago(10_000)))), h);
      expect(calls()).toBe(2);
    });
  });

  describe('auto-closed day reopen', () => {
    const closed = (over: Partial<Session> = {}): Session => ({
      id: 'ws-1',
      date: '2026-10-20',
      startedAt: ago(6 * 60 * MIN), // 04:00Z
      endedAt: ago(3 * 60 * MIN), // 07:00Z
      endReason: 'AUTO_CLOSED',
      source: 'AGENT',
      ...over,
    });

    it('reopens an AUTO_CLOSED session (and its day end) for a later replayed action, as a REPLAY session', async () => {
      prisma.sessions.push(closed());
      prisma.dayEnds.set('2026-10-20', { endedAt: ago(3 * 60 * MIN) });
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Its AUTO_CLOSED reason stays while open: a second automatic close is silent.
      expect(prisma.workSession.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { endedAt: null, source: 'REPLAY' },
      });
      expect(prisma.workDayEnd.update).toHaveBeenCalledWith({
        where: { userId_date: { userId: USER, date: '2026-10-20' } },
        data: { endedAt: null },
      });
      expect(prisma.sessions[0]).toMatchObject({
        endedAt: null,
        endReason: 'AUTO_CLOSED',
        source: 'REPLAY',
      });
      expect(limits.latestEndOfSession).toHaveBeenCalledWith({
        userId: USER,
        date: '2026-10-20',
        startedAt: ago(6 * 60 * MIN),
      });
      expect(prisma.dayEnds.get('2026-10-20')).toEqual({ endedAt: null });
      // The placeholder first (a racing copy never reopens), then the reopen, then
      // the action, which sees an open day.
      expect(calls()).toBe(1);
      const reopenOrder = prisma.$transaction.mock.invocationCallOrder[0];
      const createOrder = prisma.agentEvent.create.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(reopenOrder);
    });

    it.each([
      [
        'a validation failure (400)',
        () => new ValidationError('kind must be one of MORNING, LUNCH, EVENING'),
      ],
      ['a refusal (409)', () => new ConflictError('You are already on a break.', 'ON_BREAK')],
      ['a server failure (500)', () => new Error('database went away')],
    ])(
      'a reopened day is closed again, exactly as it was, when the action fails: %s',
      async (_why, error) => {
        prisma.sessions.push(closed());
        prisma.dayEnds.set('2026-10-20', { endedAt: ago(3 * 60 * MIN) });
        const { h } = handler(() => {
          // The action saw the day open.
          expect(prisma.sessions[0].endedAt).toBeNull();
          throw error();
        });
        await failure(run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h));
        expect(prisma.sessions[0]).toEqual(closed());
        expect(prisma.dayEnds.get('2026-10-20')).toEqual({ endedAt: ago(3 * 60 * MIN) });
      },
    );

    it('a reopened day without an End Day row is closed again without inventing one', async () => {
      prisma.sessions.push(closed({ source: 'REPLAY' }));
      const { h } = handler(() => {
        throw new ValidationError('bad');
      });
      await failure(run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h));
      expect(prisma.sessions[0]).toEqual(closed({ source: 'REPLAY' }));
      expect(prisma.workDayEnd.update).not.toHaveBeenCalled();
      expect(prisma.dayEnds.size).toBe(0);
    });

    it('a racing copy of the event (placeholder taken) never reopens the day', async () => {
      prisma.sessions.push(closed());
      prisma.agentEvent.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      const { h } = handler();
      await failure(run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.sessions[0]).toEqual(closed());
    });

    it('never reopens for a route that is not a replayed agent action, or for a client that is not a 4.0 agent', async () => {
      prisma.sessions.push(closed());
      const { h, seen } = handler();
      await run(
        interceptor,
        request(headers(EV1, ago(2 * 60 * MIN)), 'POST', {
          route: '/api/v1/approvals/:type/:id/approve',
        }),
        h,
      );
      await run(
        interceptor,
        request(headers(EV2, ago(2 * 60 * MIN)), 'POST', { ua: 'RXVisionAgent/3.1.0 (Windows)' }),
        h,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(seen).toEqual([
        { now: NOW, replay: false },
        { now: NOW, replay: false },
      ]);
    });

    it('reopens only the session when the day has no End Day row', async () => {
      prisma.sessions.push(closed());
      const { h } = handler();
      await run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h);
      expect(prisma.$transaction).toHaveBeenCalledWith([
        expect.objectContaining({ op: 'workSession.update' }),
      ]);
      expect(prisma.workDayEnd.update).not.toHaveBeenCalled();
    });

    it.each([
      ['the action happened before the close', closed(), ago(4 * 60 * MIN)],
      ['the session was ended by the person', closed({ endReason: 'USER' }), ago(2 * 60 * MIN)],
      [
        'the action is more than 20 h after the session start',
        closed({ startedAt: ago(21 * 60 * MIN), endedAt: ago(19 * 60 * MIN) }),
        ago(60 * MIN - 1000),
      ],
      ['the session is still open', closed({ endedAt: null, endReason: null }), ago(2 * 60 * MIN)],
    ])('does not reopen when %s', async (_why, session, at) => {
      prisma.sessions.push(session);
      const { h, calls } = handler();
      await run(interceptor, request(headers(EV1, at)), h);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(calls()).toBe(1);
    });

    it('does not reopen when another session is already open', async () => {
      prisma.sessions.push(
        closed(),
        closed({ id: 'ws-0', startedAt: ago(8 * 60 * MIN), endedAt: null, endReason: null }),
      );
      const { h } = handler();
      await run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("never reopens for an action past the day's latest end: it runs on the closed day (re-audit M2)", async () => {
      prisma.sessions.push(closed());
      latestEnd = ago(2 * 60 * MIN + 1000); // the day's latest end, a second before the action
      const { h, seen } = handler();
      await run(interceptor, request(headers(EV1, ago(2 * 60 * MIN))), h);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.sessions[0]).toEqual(closed());
      // The action itself still runs (and is refused by the closed day there).
      expect(seen).toEqual([{ now: ago(2 * 60 * MIN), replay: true }]);
    });

    it('a live action never reopens (only a replay does)', async () => {
      prisma.sessions.push(closed({ endedAt: ago(MIN) }));
      const { h } = handler();
      await run(interceptor, request(headers(EV1, ago(10_000))), h);
      expect(prisma.workSession.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
