import { staffGuide } from './staff-guide';

describe('staff guide (fix 8)', () => {
  const items = staffGuide({
    paidBreakBufferMin: 10,
    lateStartGraceMin: 10,
    forgottenEndDayIdleMin: 30,
    ringLeadMin: 1,
    ringDurationMin: 10,
  });

  it('has nine points and none about signing out', () => {
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(items.some((i) => /sign(ing)? out/i.test(i.title + i.body))).toBe(false);
  });

  it('point 5 says the scheduled breaks plus the buffer are paid, with the buffer from settings', () => {
    expect(items[4].body).toContain(
      'Your scheduled breaks plus a small buffer of 10 minutes are paid.',
    );
    const one = staffGuide({
      paidBreakBufferMin: 1,
      lateStartGraceMin: 10,
      forgottenEndDayIdleMin: 30,
      ringLeadMin: 1,
      ringDurationMin: 5,
    });
    expect(one[4].body).toContain('a small buffer of 1 minute are paid');
  });

  it('point 7 never says "if your company turns on"', () => {
    expect(items[6].title).toBe('Screenshots and activity');
    expect(items[6].body.toLowerCase()).not.toContain('if your company turns on');
  });
});
