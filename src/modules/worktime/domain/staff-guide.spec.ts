import { staffGuide } from './staff-guide';

describe('staff guide (fix 8)', () => {
  const numbers = {
    paidBreakBufferMin: 10,
    lateStartGraceMin: 10,
    forgottenEndDayIdleMin: 30,
    ringLeadMin: 1,
    ringDurationMin: 10,
  };
  const items = staffGuide(numbers, { fileTransfers: false });

  it('has nine points and none about signing out', () => {
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(items.some((i) => /sign(ing)? out/i.test(i.title + i.body))).toBe(false);
  });

  it('point 5 says the scheduled breaks plus the buffer are paid, with the buffer from settings', () => {
    expect(items[4].body).toContain(
      'Your scheduled breaks plus a small buffer of 10 minutes are paid.',
    );
    const one = staffGuide(
      {
        paidBreakBufferMin: 1,
        lateStartGraceMin: 10,
        forgottenEndDayIdleMin: 30,
        ringLeadMin: 1,
        ringDurationMin: 5,
      },
      { fileTransfers: false },
    );
    expect(one[4].body).toContain('a small buffer of 1 minute are paid');
  });

  it('point 7 never says "if your company turns on"', () => {
    expect(items[6].title).toBe('Screenshots and activity');
    expect(items[6].body.toLowerCase()).not.toContain('if your company turns on');
  });

  it('point 2 is the badge with the shift numbers, and says nothing of a ring or a sound (brief 1.2)', () => {
    expect(items[1].title).toBe('Breaks and reminders');
    expect(items[1].body).toBe(
      'A small badge on the icon shows 1 minute before each break. Start your break in the next ' +
        '10 minutes and nothing more is needed. Starting before or after that asks for a short ' +
        "note for your department's managers.",
    );
    expect(items.some((i) => /\b(ring|rings|sound|chime)\b/i.test(i.title + i.body))).toBe(false);
  });

  it('point 6: time marked In a meeting needs no approval and always counts (D-20)', () => {
    expect(items[5].title).toBe('Meetings');
    expect(items[5].body).toBe(
      'Tap Start meeting when you join one and End meeting when it finishes. Time marked In a ' +
        'meeting needs no approval and always counts as working and focus time. You can also log ' +
        "a meeting that already happened; your department's managers review those.",
    );
  });

  it('point 7 names file-transfer events only while red flags are on (C-714, C-917)', () => {
    const off =
      'While your day is open, RX Vision notes which app is in front, whether the keyboard or ' +
      'mouse is in use, and takes screenshots every few minutes. Nothing is recorded before ' +
      'Start day or after End day.';
    expect(items[6].body).toBe(off);
    expect(staffGuide(numbers, { fileTransfers: true })[6].body).toBe(
      'While your day is open, RX Vision notes which app is in front, whether the keyboard or ' +
        'mouse is in use and any file-transfer events, and takes screenshots every few minutes. ' +
        'Nothing is recorded before Start day or after End day.',
    );
  });
});
