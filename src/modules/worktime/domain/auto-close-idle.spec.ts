import { idleCloseDue, idleRuleFrom, realLastInput } from './auto-close';

const at = (hhmm: string) => new Date(`2026-10-14T${hhmm}:00+05:30`);

describe('forgotten End Day: idle rule (Fix 11)', () => {
  const startedAt = at('10:00');
  const shiftEnd = at('19:00');

  it('ends the day 30 minutes after the last input: input 19:30, ended at 20:00', () => {
    expect(idleCloseDue({ startedAt, shiftEnd, lastInput: at('19:30'), idleMin: 30 })).toEqual(
      at('20:00'),
    );
  });

  it('never before the shift ends: left at 14:00, ended at 19:00', () => {
    expect(idleCloseDue({ startedAt, shiftEnd, lastInput: at('14:00'), idleMin: 30 })).toEqual(
      at('19:00'),
    );
  });

  it('keeps an overtime day open while input continues', () => {
    expect(idleCloseDue({ startedAt, shiftEnd, lastInput: at('21:10'), idleMin: 30 })).toEqual(
      at('21:40'),
    );
  });

  it('with no input at all, counts from the start (never before the shift end)', () => {
    expect(idleCloseDue({ startedAt, shiftEnd, lastInput: null, idleMin: 30 })).toEqual(
      at('19:00'),
    );
  });

  it('with no shift, the rule applies 9 hours after the start', () => {
    expect(idleRuleFrom({ startedAt, shiftEnd: null })).toEqual(at('19:00'));
  });
});

describe('realLastInput', () => {
  const now = at('22:00');
  it('an idle flag after the last active sample: input stopped one threshold before it', () => {
    // Left at 19:30; the agent kept saying "active" until 19:34, flagged idle at 19:35.
    expect(
      realLastInput({
        lastActiveAt: at('19:34'),
        lastActiveSec: 60,
        nextIdleAt: at('19:35'),
        nextIdleLocked: false,
        idleThresholdSec: 300,
        now,
      }),
    ).toEqual(at('19:30'));
  });

  it('a lock is the instant work stopped', () => {
    expect(
      realLastInput({
        lastActiveAt: at('19:34'),
        lastActiveSec: 60,
        nextIdleAt: at('19:35'),
        nextIdleLocked: true,
        idleThresholdSec: 300,
        now,
      }),
    ).toEqual(at('19:35'));
  });

  it('nothing after (PC switched off): the last active sample stands its own span', () => {
    expect(
      realLastInput({
        lastActiveAt: at('19:34'),
        lastActiveSec: 60,
        nextIdleAt: null,
        nextIdleLocked: false,
        idleThresholdSec: 300,
        now,
      }),
    ).toEqual(at('19:35'));
  });

  it('no active sample at all: unknown', () => {
    expect(
      realLastInput({
        lastActiveAt: null,
        lastActiveSec: 0,
        nextIdleAt: null,
        nextIdleLocked: false,
        idleThresholdSec: 300,
        now,
      }),
    ).toBeNull();
  });
});
