import { isReplaceableAutoSkip } from './break-record.repository';

describe('isReplaceableAutoSkip', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 14, 5, min));
  // Window 05:00 to 05:59 UTC; End Day made the auto-skip at 05:10.
  const skip = { outcome: 'AUTO_SKIPPED', reason: null, startedAt: at(10), windowClose: at(59) };

  it('an End Day auto-skip inside the window, no comment, while the window is open', () => {
    expect(isReplaceableAutoSkip(skip, at(20))).toBe(true);
  });

  it('not once the window has closed', () => {
    expect(isReplaceableAutoSkip(skip, at(59))).toBe(false);
  });

  it('not when commented, made by the job after the window, a plain skip, or unscheduled', () => {
    expect(isReplaceableAutoSkip({ ...skip, reason: 'Client call' }, at(20))).toBe(false);
    expect(isReplaceableAutoSkip({ ...skip, startedAt: at(59) }, at(20))).toBe(false);
    expect(isReplaceableAutoSkip({ ...skip, outcome: 'SKIPPED' }, at(20))).toBe(false);
    expect(isReplaceableAutoSkip({ ...skip, windowClose: null }, at(20))).toBe(false);
  });
});
