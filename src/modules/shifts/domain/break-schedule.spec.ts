import {
  breakSlots,
  classifyStart,
  isWorkDay,
  overrunSeconds,
  phaseAt,
  shiftBounds,
  shiftDayKey,
  validateShiftDefinition,
} from './break-schedule';
import { ShiftDefinition } from './shift.types';

const IST = 'Asia/Kolkata';

/** 11:00 IST on 13 Oct 2026, plus minutes. */
const at = (hm: string, day = '2026-10-13') => {
  const [h, m] = hm.split(':').map(Number);
  // IST is UTC+05:30 all year.
  const utc =
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h, m) -
    330 * 60_000;
  return new Date(utc);
};

function general(over: Partial<ShiftDefinition> = {}): ShiftDefinition {
  return {
    name: 'General',
    start: '09:30',
    end: '18:30',
    workDays: [1, 2, 3, 4, 5, 6],
    ringLeadMin: 1,
    ringDurationMin: 5,
    ringSound: true,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: false,
    overrunGraceMin: 2,
    breaks: [
      {
        kind: 'MORNING',
        enabled: true,
        startTime: '11:00',
        durationMin: 15,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
      {
        kind: 'LUNCH',
        enabled: true,
        startTime: '13:00',
        durationMin: 30,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
      {
        kind: 'EVENING',
        enabled: true,
        startTime: '16:00',
        durationMin: 15,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
    ],
    ...over,
  };
}

describe('validateShiftDefinition', () => {
  it('accepts the standard General shift', () => {
    expect(validateShiftDefinition(general())).toEqual([]);
  });

  it('accepts a shift that runs past midnight', () => {
    const night = general({
      name: 'Night',
      start: '21:00',
      end: '06:00',
      breaks: [
        {
          kind: 'MORNING',
          enabled: true,
          startTime: '23:00',
          durationMin: 15,
          windowBeforeMin: 30,
          windowAfterMin: 60,
        },
        {
          kind: 'LUNCH',
          enabled: true,
          startTime: '01:30',
          durationMin: 30,
          windowBeforeMin: 30,
          windowAfterMin: 60,
        },
        {
          kind: 'EVENING',
          enabled: true,
          startTime: '04:00',
          durationMin: 15,
          windowBeforeMin: 30,
          windowAfterMin: 60,
        },
      ],
    });
    expect(validateShiftDefinition(night)).toEqual([]);
  });

  it('refuses overlapping windows, which is what lets a first break follow lunch', () => {
    const def = general();
    def.breaks[0].windowAfterMin = 150; // morning window would run to 13:30, past lunch opening at 12:30
    const problems = validateShiftDefinition(def);
    expect(problems.join(' ')).toMatch(/overlaps/);
  });

  it('refuses breaks out of order', () => {
    const def = general();
    def.breaks[0].startTime = '14:00';
    expect(validateShiftDefinition(def).join(' ')).toMatch(/morning, then lunch, then evening/);
  });

  it('refuses a break outside the shift hours', () => {
    const def = general();
    def.breaks[2].startTime = '18:20'; // 15 min break would end at 18:35, after 18:30
    def.breaks[2].windowBeforeMin = 0;
    expect(validateShiftDefinition(def).join(' ')).toMatch(/inside the shift hours/);
  });

  it('refuses a ring that starts before the window opens', () => {
    const def = general({ ringLeadMin: 10 });
    def.breaks[0].windowBeforeMin = 5;
    expect(validateShiftDefinition(def).join(' ')).toMatch(
      /ring would start before the window opens/,
    );
  });

  it('refuses a window that closes while still ringing', () => {
    const def = general({ ringLeadMin: 0, ringDurationMin: 10 });
    def.breaks[0].windowAfterMin = 5;
    expect(validateShiftDefinition(def).join(' ')).toMatch(
      /closes while the agent is still ringing/,
    );
  });

  it('ignores disabled breaks', () => {
    const def = general();
    def.breaks[1] = { ...def.breaks[1], enabled: false, startTime: '10:00' };
    expect(validateShiftDefinition(def)).toEqual([]);
  });

  it('requires a name, sane times and working days', () => {
    const problems = validateShiftDefinition(general({ name: ' ', workDays: [] }));
    expect(problems).toEqual(
      expect.arrayContaining(['Give the shift a name.', 'Pick at least one working day.']),
    );
    expect(validateShiftDefinition(general({ start: '9:30' }))).toEqual([
      'Shift start and end must be times like 09:30.',
    ]);
  });
});

describe('break slots and phases', () => {
  const slots = breakSlots(general(), '2026-10-13', IST);
  const morning = slots[0];

  it('places the three breaks at absolute instants in order', () => {
    expect(slots.map((s) => s.kind)).toEqual(['MORNING', 'LUNCH', 'EVENING']);
    expect(morning.scheduledStart.toISOString()).toBe(at('11:00').toISOString());
    expect(morning.windowOpen.toISOString()).toBe(at('10:30').toISOString());
    expect(morning.windowClose.toISOString()).toBe(at('12:00').toISOString());
    expect(morning.ringStart.toISOString()).toBe(at('10:59').toISOString());
    expect(morning.ringEnd.toISOString()).toBe(at('11:04').toISOString());
    expect(slots[1].presenceType).toBe('LUNCH');
    expect(morning.presenceType).toBe('BREAK');
  });

  it('walks through the phases at the boundaries', () => {
    expect(phaseAt(morning, at('10:29'))).toBe('UPCOMING');
    expect(phaseAt(morning, at('10:30'))).toBe('EARLY');
    expect(phaseAt(morning, at('10:59'))).toBe('DUE');
    expect(phaseAt(morning, at('11:03'))).toBe('DUE');
    expect(phaseAt(morning, at('11:04'))).toBe('LATE');
    expect(phaseAt(morning, at('11:59'))).toBe('LATE');
    expect(phaseAt(morning, at('12:00'))).toBe('CLOSED');
  });

  it('judges starts: on time while ringing, early/late with minutes otherwise', () => {
    const rules = general();
    expect(classifyStart(morning, at('11:02'), rules)).toEqual({
      timing: 'ON_TIME',
      minutesOff: 0,
      reasonRequired: false,
    });
    expect(classifyStart(morning, at('10:40'), rules)).toEqual({
      timing: 'EARLY',
      minutesOff: 20,
      reasonRequired: true,
    });
    expect(classifyStart(morning, at('11:12'), rules)).toEqual({
      timing: 'LATE',
      minutesOff: 12,
      reasonRequired: true,
    });
    expect(classifyStart(morning, at('12:30'), rules).timing).toBe('OUTSIDE_WINDOW');
  });

  it('needs no reason when the shift does not ask for one', () => {
    const rules = general({ reasonOnLate: false });
    expect(classifyStart(morning, at('11:30'), rules)).toMatchObject({
      timing: 'LATE',
      reasonRequired: false,
    });
  });

  it('skips disabled breaks', () => {
    const def = general();
    def.breaks[2].enabled = false;
    expect(breakSlots(def, '2026-10-13', IST).map((s) => s.kind)).toEqual(['MORNING', 'LUNCH']);
  });
});

describe('overnight shifts', () => {
  const night = general({
    name: 'Night',
    start: '21:00',
    end: '06:00',
    breaks: [
      {
        kind: 'MORNING',
        enabled: true,
        startTime: '23:00',
        durationMin: 15,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
      {
        kind: 'LUNCH',
        enabled: true,
        startTime: '01:30',
        durationMin: 30,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
      {
        kind: 'EVENING',
        enabled: true,
        startTime: '04:00',
        durationMin: 15,
        windowBeforeMin: 30,
        windowAfterMin: 60,
      },
    ],
  });

  it("counts the early hours as the previous evening's shift-day", () => {
    expect(shiftDayKey(night, at('02:00', '2026-10-14'), IST)).toBe('2026-10-13');
    expect(shiftDayKey(night, at('22:00', '2026-10-13'), IST)).toBe('2026-10-13');
    expect(shiftDayKey(general(), at('02:00', '2026-10-14'), IST)).toBe('2026-10-14');
  });

  it('puts lunch after midnight on the next calendar day', () => {
    const slots = breakSlots(night, '2026-10-13', IST);
    expect(slots[1].scheduledStart.toISOString()).toBe(at('01:30', '2026-10-14').toISOString());
    const bounds = shiftBounds(night, '2026-10-13', IST);
    expect(bounds.end.toISOString()).toBe(at('06:00', '2026-10-14').toISOString());
  });
});

describe('work days and overrun', () => {
  it('knows Sunday is off for a Monday-Saturday shift', () => {
    expect(isWorkDay(general(), '2026-10-18')).toBe(false);
    expect(isWorkDay(general(), '2026-10-17')).toBe(true);
  });

  it('measures how far a break ran past its length', () => {
    const start = at('11:00');
    expect(overrunSeconds(15, start, at('11:14'), at('12:00'))).toBe(0);
    expect(overrunSeconds(15, start, at('11:20'), at('12:00'))).toBe(300);
    // Still running: measured to now.
    expect(overrunSeconds(15, start, null, at('11:16'))).toBe(60);
    expect(overrunSeconds(null, start, null, at('13:00'))).toBe(0);
  });
});
