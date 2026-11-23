import { pickShiftByTime } from './shift-pick';
import { ShiftRecord } from './shift.types';

const TZ = 'Asia/Kolkata';
const TUE = '2026-11-17';

function shift(
  id: string,
  start: string,
  end: string,
  workDays = [1, 2, 3, 4, 5, 6, 7],
): ShiftRecord {
  return {
    id,
    companyId: 'co-1',
    isDefault: false,
    name: id,
    start,
    end,
    workDays,
    ringLeadMin: 1,
    ringDurationMin: 5,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: false,
    overrunGraceMin: 3,
    breaks: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

/** A local IST time on a day, as an instant. */
const at = (hm: string, day = TUE) => new Date(`${day}T${hm}:00+05:30`);

describe('pickShiftByTime (4.1: a department with several shifts)', () => {
  const day = shift('day', '06:00', '15:00');
  const eve = shift('eve', '17:00', '22:00');
  const both = [day, eve];

  it('gives the shift that is on', () => {
    expect(pickShiftByTime(both, at('07:30'), TUE, TZ)).toEqual({ shift: day, dateKey: TUE });
    expect(pickShiftByTime(both, at('18:00'), TUE, TZ)).toEqual({ shift: eve, dateKey: TUE });
  });

  it('gives the next shift in a gap, and before the first one', () => {
    expect(pickShiftByTime(both, at('16:00'), TUE, TZ)?.shift.id).toBe('eve');
    expect(pickShiftByTime(both, at('05:30'), TUE, TZ)?.shift.id).toBe('day');
  });

  it('gives the shift that ended last after the last shift of the day', () => {
    expect(pickShiftByTime(both, at('23:00'), TUE, TZ)?.shift.id).toBe('eve');
  });

  it('gives the shift that started last when two overlap', () => {
    const late = shift('late', '14:00', '23:00');
    expect(pickShiftByTime([day, late], at('14:30'), TUE, TZ)?.shift.id).toBe('late');
  });

  it("counts yesterday's overnight shift that is still running", () => {
    const night = shift('night', '22:00', '06:00');
    expect(pickShiftByTime([day, night], at('02:00'), TUE, TZ)).toEqual({
      shift: night,
      dateKey: '2026-11-16',
    });
  });

  it('skips a shift that does not work that day', () => {
    const weekdays = shift('weekdays', '17:00', '22:00', [1, 3, 5]); // not Tuesday
    expect(pickShiftByTime([day, weekdays], at('18:00'), TUE, TZ)?.shift.id).toBe('day');
    expect(pickShiftByTime([weekdays], at('18:00'), TUE, TZ)).toBeNull();
  });
});
