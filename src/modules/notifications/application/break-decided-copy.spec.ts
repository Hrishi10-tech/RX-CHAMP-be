import { decisionEffect } from '@modules/shifts/application/break-events.service';
import { effectSentence } from './break-events.subscriber';

describe('decisionEffect and effectSentence (3.3)', () => {
  const base = { overrunAsked: false, overrunSec: 0, durationMin: 15 };

  it('tells an approved skip that its minutes stay counted', () => {
    const e = decisionEffect({ ...base, outcome: 'SKIPPED', approvalStatus: 'APPROVED' });
    expect(e).toEqual({ mode: 'KEPT', minutes: 15 });
    expect(effectSentence(e)).toBe(
      'The 15 min you worked through the break stay counted as focus time, so the total does not change.',
    );
  });

  it('tells a rejected skip or auto-skip what came off', () => {
    expect(
      decisionEffect({ ...base, outcome: 'AUTO_SKIPPED', approvalStatus: 'REJECTED' }),
    ).toEqual({
      mode: 'MINUS',
      minutes: 15,
    });
    expect(effectSentence({ mode: 'MINUS', minutes: 15 })).toBe(
      '15 min taken off your focus time for that day.',
    );
  });

  it('tells an overrun what was added back, or that nothing changed', () => {
    expect(
      decisionEffect({
        outcome: 'TAKEN',
        approvalStatus: 'APPROVED',
        overrunAsked: true,
        overrunSec: 611,
        durationMin: 15,
      }),
    ).toEqual({ mode: 'PLUS', minutes: 10 });
    expect(effectSentence({ mode: 'PLUS', minutes: 10 })).toBe(
      '10 min added back to your focus time.',
    );
    expect(
      decisionEffect({
        outcome: 'TAKEN',
        approvalStatus: 'REJECTED',
        overrunAsked: true,
        overrunSec: 611,
        durationMin: 15,
      }),
    ).toEqual({ mode: 'NONE', minutes: 10 });
    expect(effectSentence({ mode: 'NONE', minutes: 10 })).toBe('No change to your focus time.');
  });

  it('says nothing special about an early or late start', () => {
    expect(decisionEffect({ ...base, outcome: 'TAKEN', approvalStatus: 'APPROVED' })).toEqual({
      mode: 'NONE',
      minutes: 0,
    });
    expect(effectSentence(null)).toBeNull();
  });
});
