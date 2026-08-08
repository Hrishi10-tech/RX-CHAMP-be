// Focus time is derived from the same activity samples as active time, so it can
// never exceed it. Before this, focus came from online heartbeats and counted the
// idle-threshold grace period, which made it report more work than active.
import { ActivitySampleRecord } from '@modules/activity/domain/activity-sample.repository';
import { ActivityMapper } from '@modules/activity/application/activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from '@modules/activity/application/activity.constants';
import { OnlineRow } from '../domain/analytics.reader';
import { computeDayProductivity } from './analytics.util';

const DAY = '2026-07-16';
const BASE = new Date(`${DAY}T09:00:00.000Z`);
// A finished day, so nothing counts "live" and totals are exact.
const NOW = new Date('2026-07-17T09:00:00.000Z');

function sample(minute: number, idle: boolean): ActivitySampleRecord {
  const at = new Date(BASE.getTime() + minute * 60_000);
  return {
    id: `s-${minute}`,
    userId: 'user-1',
    deviceId: null,
    date: DAY,
    at,
    durationSec: 60,
    idle,
    locked: false,
    app: 'Google Chrome',
    title: null,
    url: null,
  };
}

/** `n` consecutive minute-long samples, all working. */
const working = (n: number) => Array.from({ length: n }, (_, i) => sample(i, false));

/** One long online session — the old basis for focus, deliberately generous. */
const online: OnlineRow[] = [
  { startedAt: BASE, endedAt: new Date(BASE.getTime() + 8 * 3600_000), durationSec: 8 * 3600 },
];

const activeOf = (samples: ActivitySampleRecord[]) =>
  ActivityMapper.computeDaily(samples, DAY, DEFAULT_WORKING_BASIS_SEC, NOW).activeSec;

describe('computeDayProductivity — focus time', () => {
  it('counts an uninterrupted stretch of 25 minutes or more', () => {
    const samples = working(30);

    const { focusSec } = computeDayProductivity(online, [], NOW, samples);

    expect(focusSec).toBe(30 * 60);
  });

  it('ignores stretches shorter than the 25-minute minimum', () => {
    // 10 minutes of work is real, but not a focus session.
    const samples = working(10);

    const { focusSec } = computeDayProductivity(online, [], NOW, samples);

    expect(focusSec).toBe(0);
  });

  it('never reports more focus than active time', () => {
    // The online session claims 8h; the samples only justify 30 minutes.
    const samples = working(30);

    const { focusSec } = computeDayProductivity(online, [], NOW, samples);

    expect(focusSec).toBeLessThanOrEqual(activeOf(samples));
  });

  it('is zero when the agent recorded nothing, however long the day looks online', () => {
    const { focusSec } = computeDayProductivity(online, [], NOW, []);

    expect(focusSec).toBe(0);
  });

  it('splits a day broken by idle into separate stretches', () => {
    // 30 working minutes, 10 idle, then 30 more: two qualifying stretches.
    const samples = [
      ...Array.from({ length: 30 }, (_, i) => sample(i, false)),
      ...Array.from({ length: 10 }, (_, i) => sample(30 + i, true)),
      ...Array.from({ length: 30 }, (_, i) => sample(40 + i, false)),
    ];

    const { focusSec } = computeDayProductivity(online, [], NOW, samples);

    expect(focusSec).toBe(60 * 60);
  });

  it('drops a broken-up day below a solid one of the same total work', () => {
    const solid = working(60);
    // Same 60 working minutes, but chopped into 6 ten-minute bursts.
    const choppy = Array.from({ length: 6 })
      .flatMap((_, block) => [
        ...Array.from({ length: 10 }, (_, i) => sample(block * 15 + i, false)),
        ...Array.from({ length: 5 }, (_, i) => sample(block * 15 + 10 + i, true)),
      ]);

    const solidFocus = computeDayProductivity(online, [], NOW, solid).focusSec;
    const choppyFocus = computeDayProductivity(online, [], NOW, choppy).focusSec;

    expect(solidFocus).toBe(60 * 60);
    expect(choppyFocus).toBe(0); // no burst reaches 25 minutes
    expect(choppyFocus).toBeLessThan(solidFocus);
  });

  it('leaves the productivity score on its original online basis', () => {
    // Focus changed, but the score must not move: 8h online, no gaps -> 10.
    const { score } = computeDayProductivity(online, [], NOW, working(30));

    expect(score).toBe(10);
  });
});
