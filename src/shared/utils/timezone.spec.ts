import {
  addDaysToKey,
  appTimezone,
  dateKeyInZone,
  hmInZone,
  hmToMinutes,
  isValidDateKey,
  isValidHm,
  isoWeekdayOfKey,
  minutesToHm,
  startOfDayInZone,
  zonedMinutesToUtc,
  zonedTimeToUtc,
} from './timezone';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

describe('timezone helpers', () => {
  describe('day keys', () => {
    it('puts 00:10 IST on its own day even though UTC is still on the previous one', () => {
      // 18:40 UTC on the 12th is 00:10 IST on the 13th.
      const at = new Date('2026-10-12T18:40:00Z');
      expect(dateKeyInZone(at, IST)).toBe('2026-10-13');
      expect(dateKeyInZone(at, 'UTC')).toBe('2026-10-12');
      expect(hmInZone(at, IST)).toBe('00:10');
    });

    it('defaults to the configured business zone', () => {
      const prev = process.env.APP_TIMEZONE;
      process.env.APP_TIMEZONE = 'Not/AZone';
      expect(appTimezone()).toBe(IST);
      process.env.APP_TIMEZONE = NY;
      expect(appTimezone()).toBe(NY);
      process.env.APP_TIMEZONE = prev;
    });
  });

  describe('wall clock to instant', () => {
    it('converts IST wall times (no DST)', () => {
      expect(zonedTimeToUtc('2026-10-13', '11:00', IST).toISOString()).toBe(
        '2026-10-13T05:30:00.000Z',
      );
      expect(startOfDayInZone('2026-10-13', IST).toISOString()).toBe('2026-10-12T18:30:00.000Z');
    });

    it('accepts minutes past 24h for shifts that run past midnight', () => {
      // 25:30 on the 13th = 01:30 on the 14th.
      expect(zonedMinutesToUtc('2026-10-13', 25 * 60 + 30, IST).toISOString()).toBe(
        '2026-10-13T20:00:00.000Z',
      );
    });

    it('handles the spring-forward gap and the fall-back overlap', () => {
      // 2026-03-08: New York jumps from 02:00 to 03:00 (EST -> EDT).
      const before = zonedTimeToUtc('2026-03-08', '01:30', NY);
      const after = zonedTimeToUtc('2026-03-08', '03:30', NY);
      expect(before.toISOString()).toBe('2026-03-08T06:30:00.000Z');
      expect(after.toISOString()).toBe('2026-03-08T07:30:00.000Z');
      // A time in the gap lands on a real instant, never NaN.
      expect(Number.isNaN(zonedTimeToUtc('2026-03-08', '02:30', NY).getTime())).toBe(false);
      // 2026-11-01: 01:30 happens twice; we get one of them consistently.
      const ambiguous = zonedTimeToUtc('2026-11-01', '01:30', NY).toISOString();
      expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(ambiguous);
    });
  });

  describe('calendar arithmetic', () => {
    it('adds days across months and years', () => {
      expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
      expect(addDaysToKey('2028-03-01', -1)).toBe('2028-02-29');
    });

    it('gives ISO weekdays (Monday = 1, Sunday = 7)', () => {
      expect(isoWeekdayOfKey('2026-10-12')).toBe(1);
      expect(isoWeekdayOfKey('2026-10-13')).toBe(2);
      expect(isoWeekdayOfKey('2026-10-18')).toBe(7);
    });
  });

  describe('HH:MM', () => {
    it('validates and converts', () => {
      expect(isValidHm('09:30')).toBe(true);
      expect(isValidHm('24:00')).toBe(false);
      expect(isValidHm('9:30')).toBe(false);
      expect(hmToMinutes('13:45')).toBe(825);
      expect(() => hmToMinutes('25:00')).toThrow();
    });

    it('wraps minutes into a day', () => {
      expect(minutesToHm(-20)).toBe('23:40');
      expect(minutesToHm(1440 + 75)).toBe('01:15');
    });

    it('validates real calendar days only', () => {
      expect(isValidDateKey('2026-02-29')).toBe(false);
      expect(isValidDateKey('2028-02-29')).toBe(true);
      expect(isValidDateKey('2026-13-01')).toBe(false);
    });
  });
});
