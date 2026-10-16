import { DayDataService, SETTLED_AFTER_MS } from './day-data.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const NOW = new Date('2026-10-14T06:00:00Z');

function setup() {
  const reader = {
    sessionDays: jest.fn(),
    activeSecByHour: jest.fn(),
    userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set(['u1', 'u2'])),
  };
  const svc = new DayDataService(
    {} as never,
    {} as never,
    {} as never,
    reader as never,
    {} as never,
  );
  return { svc, reader };
}

describe('DayDataService hour buckets', () => {
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
