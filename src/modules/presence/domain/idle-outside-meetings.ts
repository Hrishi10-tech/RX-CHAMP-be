import { TimeInterval } from '@shared/types/common.types';
import { Interval, subtract } from '@modules/worktime/domain/intervals';

/** A stretch of a day in a meeting; a null end is still running (counts to now). */
export interface MeetingSpan {
  start: Date;
  end: Date | null;
}

const toInterval = (i: { start: Date; end: Date }): Interval => ({
  start: i.start.getTime(),
  end: i.end.getTime(),
});

const toSpans = (meetings: MeetingSpan[], now: Date): Interval[] =>
  meetings.map((m) => toInterval({ start: m.start, end: m.end ?? now }));

/**
 * Meeting time is never idle (brief 1.8, D-22): each idle interval less whatever falls
 * inside a meeting. Each sample keeps its own interval, so a day with no meeting reads
 * exactly as before.
 */
export function idleOutsideMeetings(
  idle: TimeInterval[],
  meetings: MeetingSpan[],
  now: Date,
): TimeInterval[] {
  if (!meetings.length) return idle;
  const cut = toSpans(meetings, now);
  return idle.flatMap((i) =>
    subtract([toInterval(i)], cut).map((p) => ({ start: new Date(p.start), end: new Date(p.end) })),
  );
}

/** Whole seconds of one sample's idle time left outside the meetings. */
export function idleSecOutsideMeetings(
  sample: { at: Date; durationSec: number | null },
  meetings: MeetingSpan[],
  now: Date,
): number {
  const sec = sample.durationSec ?? 0;
  if (!meetings.length || sec <= 0) return sec;
  const start = sample.at.getTime();
  const left = subtract([{ start, end: start + sec * 1000 }], toSpans(meetings, now));
  return Math.round(left.reduce((sum, p) => sum + (p.end - p.start), 0) / 1000);
}
