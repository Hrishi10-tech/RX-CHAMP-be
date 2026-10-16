import { buildHourly, dayHourWindows, hourWindows, HourlyInput } from './hourly';
import { Interval, intersect, lengthMs, normalize } from './intervals';

const TZ = 'Asia/Kolkata';
/** An India wall time as epoch ms ("2026-10-14", "18:30"). */
const ist = (date: string, hm: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - 330 * 60_000;
};
const iv = (date: string, from: string, to: string, toDate = date): Interval => ({
  start: ist(date, from),
  end: ist(toDate, to),
});

/** The 3.1 algorithm before it was optimised, as the reference. */
function reference(input: HourlyInput) {
  const work = normalize(input.work);
  const breaks = normalize(input.breaks);
  const meetings = normalize(input.meetings);
  const away = normalize([...breaks, ...meetings]);
  const base = hourWindows(input.dateKey, input.tz);
  const next = hourWindows(
    new Date(Date.parse(`${input.dateKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
    input.tz,
  );
  const windows = work.length
    ? base.map((h, i) =>
        lengthMs(intersect(work, [next[i]])) > lengthMs(intersect(work, [h])) ? next[i] : h,
      )
    : base;
  return windows.map((h, hour) => {
    const inWork = intersect(work, [h]);
    const workMs = lengthMs(inWork);
    const breakMs = lengthMs(intersect(breaks, [h]));
    const meetingMs = lengthMs(intersect(meetings, [h]));
    const availableMs = Math.max(0, workMs - lengthMs(intersect(inWork, away)));
    const activeMin = Math.min(
      60,
      Math.max(0, Math.round((input.activeSecByHour[hour] ?? 0) / 60)),
    );
    return {
      hour,
      activeMin,
      availableMin: Math.round(availableMs / 60_000),
      breakMin: Math.round(breakMs / 60_000),
      meetingMin: Math.round(meetingMs / 60_000),
      quiet:
        availableMs >= 50 * 60_000 &&
        breakMs === 0 &&
        meetingMs === 0 &&
        activeMin < input.quietHourActiveMin,
    };
  });
}

describe('hour windows of a working day', () => {
  it('a day shift keeps the day itself (the cached windows)', () => {
    const work = [iv('2026-10-14', '09:30', '18:30')];
    expect(dayHourWindows('2026-10-14', TZ, work)).toBe(hourWindows('2026-10-14', TZ));
    expect(dayHourWindows('2026-10-14', TZ, [])).toBe(hourWindows('2026-10-14', TZ));
  });

  it("a night shift's hours after midnight are the next morning's", () => {
    const work = [iv('2026-10-14', '18:30', '03:30', '2026-10-15')];
    const w = dayHourWindows('2026-10-14', TZ, work);
    expect(w[0].start).toBe(ist('2026-10-15', '00:00'));
    expect(w[3].start).toBe(ist('2026-10-15', '03:00'));
    expect(w[4].start).toBe(ist('2026-10-14', '04:00'));
    expect(w[18].start).toBe(ist('2026-10-14', '18:00'));
    expect(w[23].end).toBe(ist('2026-10-15', '00:00'));
  });
});

describe('buildHourly', () => {
  it('matches the reference on day and night shifts with breaks and meetings', () => {
    const cases: HourlyInput[] = [
      {
        dateKey: '2026-10-14',
        tz: TZ,
        work: [iv('2026-10-14', '09:30', '13:10'), iv('2026-10-14', '13:40', '18:45')],
        breaks: [iv('2026-10-14', '11:00', '11:17'), iv('2026-10-14', '13:00', '13:45')],
        meetings: [iv('2026-10-14', '15:00', '15:30'), iv('2026-10-14', '15:20', '16:05')],
        activeSecByHour: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 19 ? h * 170 : 0)),
        quietHourActiveMin: 20,
      },
      {
        dateKey: '2026-10-14',
        tz: TZ,
        work: [iv('2026-10-14', '18:30', '03:30', '2026-10-15')],
        breaks: [iv('2026-10-14', '23:40', '00:20', '2026-10-15')],
        meetings: [iv('2026-10-15', '01:00', '01:50')],
        activeSecByHour: Array.from({ length: 24 }, (_, h) => (h < 4 || h > 17 ? 1500 : 0)),
        quietHourActiveMin: 30,
      },
      {
        dateKey: '2026-10-14',
        tz: TZ,
        work: [],
        breaks: [],
        meetings: [],
        activeSecByHour: [],
        quietHourActiveMin: 20,
      },
    ];
    for (const c of cases) expect(buildHourly(c)).toEqual(reference(c));
  });

  it('a quiet hour: 50+ available minutes, no break or meeting, little activity', () => {
    const hours = buildHourly({
      dateKey: '2026-10-14',
      tz: TZ,
      work: [iv('2026-10-14', '09:30', '18:30')],
      breaks: [iv('2026-10-14', '11:00', '11:15')],
      meetings: [],
      activeSecByHour: Array.from({ length: 24 }, (_, h) => (h === 14 ? 600 : 3000)),
      quietHourActiveMin: 20,
    });
    expect(hours[14]).toMatchObject({ availableMin: 60, activeMin: 10, quiet: true });
    expect(hours[11]).toMatchObject({ breakMin: 15, availableMin: 45, quiet: false });
    expect(hours[9]).toMatchObject({ availableMin: 30, quiet: false });
  });
});
