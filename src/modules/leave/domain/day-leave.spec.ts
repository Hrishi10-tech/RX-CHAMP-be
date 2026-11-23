import {
  dayLeaveView,
  expectedAfterLeave,
  leaveSecOf,
  NO_LEAVE,
  shiftAfterLeave,
} from './day-leave';

const leave = (mask: number, over: Partial<typeof NO_LEAVE> = {}) => {
  let units = 0;
  for (let m = mask; m; m >>= 1) units += m & 1;
  return { ...NO_LEAVE, mask, units, clslUnits: units, full: mask === 15, ...over };
};

describe('day leave (3.4)', () => {
  it('expected time left and paid leave time', () => {
    expect(expectedAfterLeave(8 * 3600, leave(15))).toBe(0);
    expect(expectedAfterLeave(8 * 3600, leave(3))).toBe(4 * 3600);
    expect(expectedAfterLeave(8 * 3600, leave(1))).toBe(6 * 3600);
    expect(expectedAfterLeave(8 * 3600, undefined)).toBe(8 * 3600);
    expect(leaveSecOf(8 * 3600, leave(12))).toBe(4 * 3600);
  });

  it('moves the start past leave at the start of the day, the end before leave at its end', () => {
    const s = new Date('2026-11-09T04:00:00Z');
    const e = new Date('2026-11-09T13:00:00Z');
    expect(shiftAfterLeave(s, e, leave(3)).start?.toISOString()).toBe('2026-11-09T08:30:00.000Z');
    expect(shiftAfterLeave(s, e, leave(8)).end?.toISOString()).toBe('2026-11-09T10:45:00.000Z');
    expect(shiftAfterLeave(s, e, leave(15))).toEqual({ start: s, end: e });
    expect(shiftAfterLeave(null, e, leave(3))).toEqual({ start: null, end: e });
  });

  it('labels the day', () => {
    expect(dayLeaveView(undefined)).toBeNull();
    expect(dayLeaveView(NO_LEAVE)).toBeNull();
    expect(dayLeaveView(leave(15))).toMatchObject({
      days: 1,
      full: true,
      label: 'Full day',
      categories: 'CL/SL',
    });
    expect(dayLeaveView(leave(12))).toMatchObject({ days: 0.5, label: 'Half day (second half)' });
    expect(dayLeaveView(leave(4))).toMatchObject({
      days: 0.25,
      label: 'Quarter day (3rd quarter)',
    });
    expect(dayLeaveView(leave(5))).toMatchObject({ label: '2 quarters of the day' });
    expect(dayLeaveView({ ...NO_LEAVE, pendingMask: 3 })).toMatchObject({
      days: 0,
      label: 'Waiting for approval',
      pendingDays: 0.5,
    });
    expect(
      dayLeaveView({ ...leave(3), clslUnits: 0, elplUnits: 2, pendingMask: 12 }),
    ).toMatchObject({ categories: 'EL/PL', elplDays: 0.5, pendingDays: 0.5 });
  });
});
