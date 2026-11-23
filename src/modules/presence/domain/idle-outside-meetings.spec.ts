import { idleOutsideMeetings, idleSecOutsideMeetings } from './idle-outside-meetings';

const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00+05:30`);
const NOW = at('18:00');

describe('idle is never inside a meeting (D-22)', () => {
  const idle = [
    { start: at('10:00'), end: at('10:02') },
    { start: at('10:02'), end: at('10:04') },
    { start: at('11:00'), end: at('11:02') },
  ];

  it('leaves a day with no meeting exactly as it was', () => {
    expect(idleOutsideMeetings(idle, [], NOW)).toBe(idle);
  });

  it('drops what falls inside a meeting and cuts what crosses its end', () => {
    const left = idleOutsideMeetings(idle, [{ start: at('09:30'), end: at('10:03') }], NOW);
    expect(left).toEqual([
      { start: at('10:03'), end: at('10:04') },
      { start: at('11:00'), end: at('11:02') },
    ]);
  });

  it('a running meeting counts to now', () => {
    expect(idleOutsideMeetings(idle, [{ start: at('09:30'), end: null }], NOW)).toEqual([]);
  });

  it('keeps samples that overlap each other apart, as the sum always did', () => {
    const twoPcs = [
      { start: at('10:00'), end: at('10:02') },
      { start: at('10:00'), end: at('10:02') },
    ];
    const left = idleOutsideMeetings(twoPcs, [{ start: at('10:01'), end: at('10:30') }], NOW);
    expect(left).toHaveLength(2);
  });
});

describe('idleSecOutsideMeetings', () => {
  const sample = { at: at('10:00'), durationSec: 120 };

  it('a sample outside every meeting keeps its seconds', () => {
    expect(idleSecOutsideMeetings(sample, [], NOW)).toBe(120);
    expect(idleSecOutsideMeetings(sample, [{ start: at('11:00'), end: at('12:00') }], NOW)).toBe(
      120,
    );
  });

  it('a sample inside a meeting has none', () => {
    expect(idleSecOutsideMeetings(sample, [{ start: at('09:00'), end: at('10:30') }], NOW)).toBe(0);
    expect(idleSecOutsideMeetings(sample, [{ start: at('09:00'), end: null }], NOW)).toBe(0);
  });

  it('a sample crossing the end of a meeting keeps the part after it', () => {
    expect(idleSecOutsideMeetings(sample, [{ start: at('09:00'), end: at('10:01') }], NOW)).toBe(
      60,
    );
  });

  it('an empty sample stays empty', () => {
    expect(idleSecOutsideMeetings({ at: at('10:00'), durationSec: null }, [], NOW)).toBe(0);
  });
});
