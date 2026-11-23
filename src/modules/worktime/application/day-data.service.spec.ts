import { ActivityBackfilledEvent } from '@shared/events/activity-backfilled.event';
import { DayDataService, focusOfDay, PersonDayData, SETTLED_AFTER_MS } from './day-data.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const NOW = new Date('2026-10-14T06:00:00Z');

function setup() {
  const reader = {
    sessionDays: jest.fn(),
    activeSecByHour: jest.fn(),
    inputOfDays: jest.fn().mockResolvedValue(new Map()),
    userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set(['u1', 'u2'])),
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const events = {
    publish: jest.fn(),
    subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
  };
  const svc = new DayDataService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    reader as never,
    {} as never,
    events as never,
    {} as never,
  );
  svc.onModuleInit();
  /** What report-activity announces when samples change a closed day. */
  const backfilled = (userId: string) =>
    handlers.get(ActivityBackfilledEvent.eventName)!(new ActivityBackfilledEvent(userId));
  return { svc, reader, backfilled };
}

/** A DayDataService whose repositories hold these rows. */
function loaded(rows: {
  sessions?: any[];
  breaks?: any[];
  meetings?: any[];
  away?: any[];
  presence?: any[];
  adjustments?: any[];
}) {
  const sessions = { listForUsersBetween: jest.fn().mockResolvedValue(rows.sessions ?? []) };
  const breaks = { listForUsersBetween: jest.fn().mockResolvedValue(rows.breaks ?? []) };
  const meetings = { listForUsersBetween: jest.fn().mockResolvedValue(rows.meetings ?? []) };
  const away = { listForUsers: jest.fn().mockResolvedValue(rows.away ?? []) };
  const adjustments = {
    listForUsersBetween: jest.fn().mockResolvedValue(rows.adjustments ?? []),
  };
  const reader = {
    presenceOverlapping: jest.fn().mockResolvedValue(rows.presence ?? []),
    activityCoverage: jest.fn().mockResolvedValue([]),
  };
  const meetingService = { heal: jest.fn().mockResolvedValue(undefined) };
  const handlers = new Map<string, (e: unknown) => void>();
  const events = {
    publish: jest.fn(),
    subscribe: jest.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
  };
  const svc = new DayDataService(
    sessions as never,
    breaks as never,
    meetings as never,
    away as never,
    reader as never,
    meetingService as never,
    events as never,
    adjustments as never,
  );
  svc.onModuleInit();
  const backfilled = (userId: string) =>
    handlers.get(ActivityBackfilledEvent.eventName)!(new ActivityBackfilledEvent(userId));
  return { svc, sessions, breaks, meetings, away, adjustments, reader, meetingService, backfilled };
}

const at = (iso: string) => new Date(iso);
const sess = (userId: string, date: string, from: string, to: string | null) => ({
  id: `${userId}-${date}`,
  userId,
  date,
  startedAt: at(from),
  endedAt: to ? at(to) : null,
  endReason: to ? 'USER' : null,
  source: 'AGENT',
});

describe('DayDataService.load', () => {
  it('reads every table once for all people and days, and away stretches per (person, day)', async () => {
    const away = [
      {
        id: 'a1',
        userId: 'u1',
        date: '2026-10-13',
        status: 'PENDING',
        startedAt: at('2026-10-13T06:00:00Z'),
        endedAt: at('2026-10-13T06:20:00Z'),
      },
      {
        id: 'a2',
        userId: 'u1',
        date: '2026-10-14',
        status: 'APPROVED',
        startedAt: at('2026-10-14T05:00:00Z'),
        endedAt: at('2026-10-14T05:10:00Z'),
      },
      {
        id: 'a3',
        userId: 'u2',
        date: '2026-10-13',
        status: 'UNEXPLAINED',
        startedAt: at('2026-10-13T07:00:00Z'),
        endedAt: null,
      },
    ];
    const t = loaded({
      sessions: [
        sess('u1', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z'),
        sess('u2', '2026-10-13', '2026-10-13T04:30:00Z', null),
      ],
      away,
    });
    const set = await t.svc.load(['u1', 'u2'], '2026-10-13', '2026-10-14', NOW, { heal: true });
    expect(t.meetingService.heal).toHaveBeenCalledWith(['u1', 'u2'], NOW);
    expect(t.away.listForUsers).toHaveBeenCalledWith(['u1', 'u2'], '2026-10-13', '2026-10-14');
    expect(t.sessions.listForUsersBetween).toHaveBeenCalledTimes(1);
    expect(t.reader.presenceOverlapping).toHaveBeenCalledWith(
      ['u1', 'u2'],
      at('2026-10-13T04:00:00Z'),
      NOW,
    );
    expect(set.day('u1', '2026-10-13').away!.map((a) => a.id)).toEqual(['a1']);
    expect(set.day('u1', '2026-10-14').away!.map((a) => a.id)).toEqual(['a2']);
    expect(set.day('u2', '2026-10-13').away!.map((a) => a.id)).toEqual(['a3']);
    expect(set.day('u2', '2026-10-14').away).toEqual([]);
  });

  it('3.3: manual adjustments are read once and enter the focus of their own (person, day) only', async () => {
    const adj = (id: string, userId: string, date: string, deltaSec: number, voided = false) => ({
      id,
      userId,
      date,
      deltaSec,
      reason: 'Agent crashed',
      createdById: 'sm',
      createdAt: NOW,
      voidedAt: voided ? NOW : null,
      voidedById: voided ? 'sm' : null,
    });
    const t = loaded({
      sessions: [sess('u1', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T08:00:00Z')],
      adjustments: [
        adj('a1', 'u1', '2026-10-13', 30 * 60),
        adj('a2', 'u1', '2026-10-13', 3600, true),
        adj('a3', 'u1', '2026-10-14', 45 * 60),
        adj('a4', 'u2', '2026-10-13', -5 * 3600),
      ],
    });
    const set = await t.svc.load(['u1', 'u2'], '2026-10-13', '2026-10-14', NOW);
    expect(t.adjustments.listForUsersBetween).toHaveBeenCalledTimes(1);
    expect(t.adjustments.listForUsersBetween).toHaveBeenCalledWith(
      ['u1', 'u2'],
      '2026-10-13',
      '2026-10-14',
    );
    // 4 h worked + 30 min by hand; the voided hour does not count but stays on the day.
    const d = set.day('u1', '2026-10-13');
    expect(d.adjustments!.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(focusOfDay(d, NOW)).toMatchObject({ focusSec: 4.5 * 3600, adjustedSec: 1800 });
    expect(focusOfDay(d, NOW).paidSec).toBe(4.5 * 3600);
    // A day with no work: the adjustment alone is its focus time.
    expect(focusOfDay(set.day('u1', '2026-10-14'), NOW).focusSec).toBe(45 * 60);
    // Never below zero.
    expect(focusOfDay(set.day('u2', '2026-10-13'), NOW)).toMatchObject({
      focusSec: 0,
      adjustedSec: -5 * 3600,
    });
  });

  it('a day keeps only the presence overlapping its sessions; no sessions, no presence query', async () => {
    const t = loaded({
      sessions: [sess('u1', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z')],
      presence: [
        {
          userId: 'u1',
          type: 'BREAK',
          startedAt: at('2026-10-13T06:00:00Z'),
          endedAt: at('2026-10-13T06:15:00Z'),
        },
        {
          userId: 'u1',
          type: 'BREAK',
          startedAt: at('2026-10-13T14:00:00Z'),
          endedAt: at('2026-10-13T14:15:00Z'),
        },
      ],
    });
    const set = await t.svc.load(['u1'], '2026-10-13', '2026-10-13', NOW);
    expect(t.meetingService.heal).not.toHaveBeenCalled();
    expect(set.day('u1', '2026-10-13').presence).toHaveLength(1);

    const empty = loaded({});
    const none = await empty.svc.load(['u1'], '2026-10-13', '2026-10-13', NOW);
    expect(empty.reader.presenceOverlapping).not.toHaveBeenCalled();
    expect(none.day('u1', '2026-10-13')).toMatchObject({ sessions: [], presence: [], away: [] });
    // Nobody asked: nothing read at all.
    await empty.svc.load([], '2026-10-13', '2026-10-13', NOW, { heal: true });
    expect(empty.sessions.listForUsersBetween).toHaveBeenCalledTimes(1);
    expect(empty.meetingService.heal).not.toHaveBeenCalled();
  });

  it('activity coverage is read once, for the REPLAY sessions only, and reaches their days and focus', async () => {
    const replayed = {
      ...sess('u1', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z'),
      source: 'REPLAY',
    };
    const live = sess('u2', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z');
    const t = loaded({ sessions: [replayed, live] });
    t.reader.activityCoverage.mockResolvedValue([
      {
        userId: 'u1',
        sessionId: replayed.id,
        startedAt: at('2026-10-13T04:00:00Z'),
        endedAt: at('2026-10-13T08:00:00Z'),
      },
    ]);
    const set = await t.svc.load(['u1', 'u2'], '2026-10-13', '2026-10-13', NOW);
    expect(t.reader.activityCoverage).toHaveBeenCalledTimes(1);
    expect(t.reader.activityCoverage).toHaveBeenCalledWith([replayed.id]);
    expect(set.day('u1', '2026-10-13').coverage).toHaveLength(1);
    expect(set.day('u2', '2026-10-13').coverage).toEqual([]);
    // 9 hours replayed, 4 covered: 5 hours unverified; the live day is whole.
    expect(focusOfDay(set.day('u1', '2026-10-13'), NOW)).toMatchObject({
      focusSec: 4 * 3600,
      unverifiedSec: 5 * 3600,
    });
    expect(focusOfDay(set.day('u2', '2026-10-13'), NOW)).toMatchObject({
      focusSec: 9 * 3600,
      unverifiedSec: 0,
    });

    // An ordinary day (no REPLAY session) never asks for coverage.
    const plain = loaded({ sessions: [live] });
    await plain.svc.load(['u2'], '2026-10-13', '2026-10-13', NOW);
    expect(plain.reader.activityCoverage).not.toHaveBeenCalled();
  });

  it("a closed REPLAY session's coverage is reused until a sample or the session changes", async () => {
    const closed = {
      ...sess('u1', '2026-10-13', '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z'),
      source: 'REPLAY',
    };
    const open = { ...sess('u2', '2026-10-14', '2026-10-14T04:00:00Z', null), source: 'REPLAY' };
    const t = loaded({ sessions: [closed, open] });
    const piece = (s: { id: string; userId: string }) => ({
      userId: s.userId,
      sessionId: s.id,
      startedAt: at('2026-10-13T04:00:00Z'),
      endedAt: at('2026-10-13T05:00:00Z'),
    });
    const coverage = jest.fn(async (ids: string[]) =>
      [closed, open].filter((s) => ids.includes(s.id)).map(piece),
    );
    Object.assign(t.reader, { activityCoverage: coverage });
    const load = () => t.svc.load(['u1', 'u2'], '2026-10-13', '2026-10-14', NOW);

    expect((await load()).day('u1', '2026-10-13').coverage).toHaveLength(1);
    const again = await load();
    // The open one is read every time; the closed one comes from memory, unchanged.
    expect(coverage.mock.calls).toEqual([[[closed.id, open.id]], [[open.id]]]);
    expect(again.day('u1', '2026-10-13').coverage).toEqual([piece(closed)]);

    t.backfilled('u1'); // a late sample of u1
    await load();
    expect(coverage.mock.calls[2]).toEqual([[closed.id, open.id]]);

    // The session itself changed (its end moved): read again.
    t.sessions.listForUsersBetween.mockResolvedValue([
      { ...closed, endedAt: at('2026-10-13T14:00:00Z') },
      open,
    ]);
    await load();
    expect(coverage.mock.calls[3]).toEqual([[closed.id, open.id]]);
  });

  it('openPresence is the newest open presence session of a person', async () => {
    const t = loaded({
      sessions: [sess('u1', '2026-10-14', '2026-10-14T04:00:00Z', null)],
      presence: [
        { userId: 'u1', type: 'BREAK', startedAt: at('2026-10-14T04:30:00Z'), endedAt: null },
        { userId: 'u1', type: 'MEETING', startedAt: at('2026-10-14T05:00:00Z'), endedAt: null },
        {
          userId: 'u1',
          type: 'LUNCH',
          startedAt: at('2026-10-14T05:30:00Z'),
          endedAt: at('2026-10-14T05:40:00Z'),
        },
      ],
    });
    const set = await t.svc.load(['u1'], '2026-10-14', '2026-10-14', NOW);
    expect(set.openPresence('u1')?.type).toBe('MEETING');
    expect(set.openPresence('u2')).toBeNull();
  });
});

describe('DayDataService hour buckets', () => {
  it('a day settles only after the 7-day offline backlog window (plus an hour)', () => {
    expect(SETTLED_AFTER_MS).toBe(7 * 24 * 3_600_000 + 3_600_000);
  });

  it('a settled day is aggregated once, then served from memory; a recent day every time', async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([
      { userId: 'u1', date: '2026-10-01', settled: true },
      { userId: 'u1', date: '2026-10-13', settled: false },
      { userId: 'u2', date: '2026-10-01', settled: true },
    ]);
    reader.activeSecByHour.mockResolvedValue([
      { userId: 'u1', date: '2026-10-01', hour: 10, activeSec: 1800 },
      { userId: 'u1', date: '2026-10-01', hour: 10, activeSec: 600 },
      { userId: 'u1', date: '2026-10-13', hour: 9, activeSec: 900 },
    ]);
    const first = await svc.bucketHours(['u1', 'u2'], '2026-10-01', '2026-10-14', NOW);
    expect(reader.sessionDays).toHaveBeenCalledWith(
      ['u1', 'u2'],
      '2026-10-01',
      '2026-10-14',
      new Date(NOW.getTime() - SETTLED_AFTER_MS),
    );
    expect(reader.activeSecByHour.mock.calls[0][0]).toHaveLength(3);
    expect(first.get('u1|2026-10-01')?.[10]).toBe(2400);
    // A settled day with no activity is all zeros (and kept too).
    expect(first.get('u2|2026-10-01')).toEqual(Array(24).fill(0));

    reader.activeSecByHour.mockResolvedValue([
      { userId: 'u1', date: '2026-10-13', hour: 9, activeSec: 1200 },
    ]);
    const second = await svc.bucketHours(['u1', 'u2'], '2026-10-01', '2026-10-14', NOW);
    expect(reader.activeSecByHour.mock.calls[1][0]).toEqual([
      { userId: 'u1', date: '2026-10-13', settled: false },
    ]);
    expect(second.get('u1|2026-10-01')).toEqual(first.get('u1|2026-10-01'));
    expect(second.get('u2|2026-10-01')).toEqual(Array(24).fill(0));
    expect(second.get('u1|2026-10-13')?.[9]).toBe(1200);
  });

  it('a closed day inside the backlog window is reused until its sessions or samples change', async () => {
    const { svc, reader, backfilled } = setup();
    const closed = { userId: 'u1', date: '2026-10-10', settled: false, closed: true, stamp: '1|a' };
    const other = { userId: 'u2', date: '2026-10-10', settled: false, closed: true, stamp: '1|b' };
    reader.sessionDays.mockResolvedValue([closed, other]);
    reader.activeSecByHour.mockResolvedValue([
      { userId: 'u1', date: '2026-10-10', hour: 10, activeSec: 600 },
    ]);
    const ask = () => svc.bucketHours(['u1', 'u2'], '2026-10-10', '2026-10-10', NOW);
    expect((await ask()).get('u1|2026-10-10')?.[10]).toBe(600);
    await ask();
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(1);

    // A late sample of u1 (offline backlog): u1's day again, u2's still from memory.
    backfilled('u1');
    reader.activeSecByHour.mockResolvedValue([
      { userId: 'u1', date: '2026-10-10', hour: 10, activeSec: 900 },
    ]);
    expect((await ask()).get('u1|2026-10-10')?.[10]).toBe(900);
    expect(reader.activeSecByHour.mock.calls[1][0]).toEqual([closed]);
    await ask();
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(2);

    // Its sessions changed (a replayed session, a moved automatic close).
    reader.sessionDays.mockResolvedValue([{ ...closed, stamp: '2|c' }, other]);
    await ask();
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(3);
    expect(reader.activeSecByHour.mock.calls[2][0]).toEqual([{ ...closed, stamp: '2|c' }]);
  });

  it('an open day is aggregated every time; a closed one again after the safety interval', async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([
      { userId: 'u1', date: '2026-10-14', settled: false, closed: false, stamp: '1|a' },
      { userId: 'u1', date: '2026-10-13', settled: false, closed: true, stamp: '1|b' },
    ]);
    reader.activeSecByHour.mockResolvedValue([]);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    try {
      await svc.bucketHours(['u1'], '2026-10-13', '2026-10-14', NOW);
      await svc.bucketHours(['u1'], '2026-10-13', '2026-10-14', NOW);
      expect(reader.activeSecByHour.mock.calls.map((c) => c[0].length)).toEqual([2, 1]);
      clock.mockReturnValue(NOW.getTime() + 31 * 60_000);
      await svc.bucketHours(['u1'], '2026-10-13', '2026-10-14', NOW);
      expect(reader.activeSecByHour.mock.calls[2][0]).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('nothing settled, nothing cached; no days, no aggregate at all', async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([{ userId: 'u1', date: '2026-10-14', settled: false }]);
    reader.activeSecByHour.mockResolvedValue([]);
    await svc.bucketHours(['u1'], '2026-10-14', '2026-10-14', NOW);
    await svc.bucketHours(['u1'], '2026-10-14', '2026-10-14', NOW);
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(2);

    reader.sessionDays.mockResolvedValue([]);
    expect((await svc.bucketHours(['u1'], '2026-10-14', '2026-10-14', NOW)).size).toBe(0);
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(2);
    expect((await svc.bucketHours([], '2026-10-14', '2026-10-14', NOW)).size).toBe(0);
  });

  it('warming covers last month and this month for everyone who worked', async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([
      { userId: 'u1', date: '2026-09-30', settled: true },
      { userId: 'u2', date: '2026-10-02', settled: true },
    ]);
    reader.activeSecByHour.mockResolvedValue([]);
    expect(await svc.warmSettled(NOW)).toBe(2);
    expect(reader.userIdsWithSessionsBetween).toHaveBeenCalledWith(
      null,
      '2026-09-01',
      '2026-10-14',
    );
    expect(reader.sessionDays.mock.calls[0].slice(0, 3)).toEqual([
      ['u1', 'u2'],
      '2026-09-01',
      '2026-10-14',
    ]);
    // Already warm: nothing new, nothing aggregated again.
    expect(await svc.warmSettled(NOW)).toBe(0);
    expect(reader.activeSecByHour).toHaveBeenCalledTimes(1);
    expect(reader.inputOfDays).toHaveBeenCalledTimes(1);
  });

  it("a person's day view reads the same buckets as the team and month views", async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([{ userId: 'u1', date: '2026-10-13', settled: false }]);
    reader.activeSecByHour.mockResolvedValue([
      { userId: 'u1', date: '2026-10-13', hour: 10, activeSec: 1500 },
    ]);
    const day = {
      userId: 'u1',
      date: '2026-10-13',
      sessions: [
        {
          id: 's1',
          userId: 'u1',
          date: '2026-10-13',
          startedAt: new Date('2026-10-13T04:00:00Z'),
          endedAt: new Date('2026-10-13T13:00:00Z'),
          endReason: 'USER' as const,
          source: 'AGENT' as const,
        },
      ],
      presence: [],
      breakRecords: [],
      meetingRecords: [],
    };
    const hourly = await svc.hourlyFor(day, NOW, 20);
    const buckets = await svc.bucketHours(['u1'], '2026-10-13', '2026-10-13', NOW);
    expect(hourly).toEqual(svc.bucketHourly(day, buckets, NOW, 20));
    expect(hourly[10].activeMin).toBe(25);
  });
});

describe('DayDataService.inputBetween and idleFrom: a month of idle (3.6)', () => {
  const ON = '2026-10-13';
  const at = (hhmm: string) => new Date(`${ON}T${hhmm}:00+05:30`);
  const ms = (hhmm: string) => at(hhmm).getTime();
  const LATER = new Date(`${ON}T20:00:00+05:30`);
  const worked = (over: Partial<PersonDayData> = {}): PersonDayData => ({
    userId: 'u1',
    date: ON,
    sessions: [
      {
        id: 's1',
        userId: 'u1',
        date: ON,
        startedAt: at('09:00'),
        endedAt: at('18:00'),
        endReason: 'USER',
        source: 'AGENT',
      },
    ],
    presence: [],
    breakRecords: [],
    meetingRecords: [],
    ...over,
  });
  const logged = (approvalStatus: string) =>
    ({
      mode: 'PAST',
      approvalStatus,
      startedAt: at('14:00'),
      endedAt: at('14:30'),
    }) as unknown as PersonDayData['meetingRecords'][number];
  const inputOfU1 = new Map([
    [
      `u1|${ON}`,
      {
        active: [{ start: ms('09:00'), end: ms('14:00') }],
        idle: [{ start: ms('14:00'), end: ms('15:00') }],
      },
    ],
  ]);

  it('a settled day is read once, then served from memory; a recent day every time', async () => {
    const { svc, reader } = setup();
    reader.sessionDays.mockResolvedValue([
      { userId: 'u1', date: '2026-10-01', settled: true },
      { userId: 'u1', date: ON, settled: false },
    ]);
    reader.inputOfDays.mockResolvedValue(
      new Map([['u1|2026-10-01', { active: [], idle: [{ start: 1, end: 2 }] }]]),
    );
    const first = await svc.inputBetween(['u1'], '2026-10-01', '2026-10-14', NOW);
    expect(first.get('u1|2026-10-01')?.idle).toEqual([{ start: 1, end: 2 }]);
    // A day nobody reported on is known too, with nothing in it.
    expect(first.get(`u1|${ON}`)).toEqual({ active: [], idle: [] });
    await svc.inputBetween(['u1'], '2026-10-01', '2026-10-14', NOW);
    expect(reader.inputOfDays.mock.calls[1][0]).toEqual([
      { userId: 'u1', date: ON, settled: false },
    ]);
  });

  it('nobody to read: no query', async () => {
    const { svc, reader } = setup();
    expect((await svc.inputBetween([], ON, ON, NOW)).size).toBe(0);
    expect(reader.sessionDays).not.toHaveBeenCalled();
  });

  it('idle is what falls in the available time: meetings and breaks stay out', () => {
    const { svc } = setup();
    expect(svc.idleFrom(worked(), inputOfU1, LATER)).toBe(3600);
    const meeting = {
      id: 'p1',
      userId: 'u1',
      type: 'MEETING' as const,
      note: null,
      date: ON,
      startedAt: at('14:00'),
      endedAt: at('14:45'),
    };
    expect(svc.idleFrom(worked({ presence: [meeting] }), inputOfU1, LATER)).toBe(15 * 60);
  });

  it('a day no agent reported on has no figure', () => {
    const { svc } = setup();
    expect(svc.idleFrom(worked(), new Map(), LATER)).toBeNull();
  });

  it('a logged meeting counts until a manager rejects it', () => {
    const { svc } = setup();
    const on = (status: string) =>
      svc.idleFrom(worked({ meetingRecords: [logged(status)] }), inputOfU1, LATER);
    expect(on('PENDING')).toBe(30 * 60);
    expect(on('APPROVED')).toBe(30 * 60);
    expect(on('REJECTED')).toBe(3600);
  });
});

describe('DayDataService.inputOf (3.6)', () => {
  const at = (hhmm: string) => new Date(`2026-10-14T${hhmm}:00+05:30`);
  const day = (userId: string, presence: PersonDayData['presence'] = []): PersonDayData => ({
    userId,
    date: '2026-10-14',
    sessions: [
      {
        id: `s-${userId}`,
        userId,
        date: '2026-10-14',
        startedAt: at('09:00'),
        endedAt: at('11:00'),
        endReason: 'USER',
        source: 'AGENT',
      },
    ],
    presence,
    breakRecords: [],
    meetingRecords: [],
  });
  const idle = (hhmm: string) => ({
    at: at(hhmm),
    durationSec: 120,
    idle: true,
    locked: false,
    app: null,
  });
  const inputService = (samples: { samplesInWindows: jest.Mock }) =>
    new DayDataService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      samples as never,
    );

  it('reads many days in one query and leaves meetings out of the idle time', async () => {
    const samples = {
      samplesInWindows: jest.fn().mockResolvedValue(
        new Map([
          ['a|2026-10-14', [idle('09:30')]],
          ['b|2026-10-14', [idle('09:30')]],
        ]),
      ),
    };
    const meeting = {
      id: 'p1',
      userId: 'b',
      type: 'MEETING' as const,
      note: null,
      date: '2026-10-14',
      startedAt: at('09:00'),
      endedAt: at('10:00'),
    };
    const out = await inputService(samples).inputOf([day('a'), day('b', [meeting])], at('12:00'));
    expect(samples.samplesInWindows).toHaveBeenCalledTimes(1);
    expect(samples.samplesInWindows.mock.calls[0][0]).toHaveLength(2);
    expect(out.get('a|2026-10-14')?.idleSec).toBeGreaterThan(0);
    expect(out.get('b|2026-10-14')?.idleSec).toBe(0);
  });

  it('a logged meeting left out of idle until a manager rejects it', async () => {
    const samples = {
      samplesInWindows: jest
        .fn()
        .mockResolvedValue(
          new Map([['a|2026-10-14', [idle('09:30'), idle('09:32'), idle('09:34')]]]),
        ),
    };
    const withLogged = (approvalStatus: string): PersonDayData => ({
      ...day('a'),
      meetingRecords: [
        {
          mode: 'PAST',
          approvalStatus,
          startedAt: at('09:30'),
          endedAt: at('09:36'),
        } as unknown as PersonDayData['meetingRecords'][number],
      ],
    });
    const idleWhen = async (status: string) =>
      (await inputService(samples).inputOf([withLogged(status)], at('12:00'))).get('a|2026-10-14');
    expect((await idleWhen('PENDING'))?.idleSec).toBe(0);
    expect((await idleWhen('APPROVED'))?.idleSec).toBe(0);
    // Rejected: its six minutes are read like any other.
    expect((await idleWhen('REJECTED'))?.idleSec).toBe(360);
    expect((await idleWhen('REJECTED'))?.spanSec).toBe(2 * 3600);
  });

  it('a day with no time available reads nothing and is all zeros', async () => {
    const samples = { samplesInWindows: jest.fn() };
    const empty: PersonDayData = { ...day('a'), sessions: [] };
    const out = await inputService(samples).inputOf([empty], at('12:00'));
    expect(samples.samplesInWindows).not.toHaveBeenCalled();
    expect(out.get('a|2026-10-14')).toEqual({ activeSec: 0, idleSec: 0, noDataSec: 0, spanSec: 0 });
  });
});
