/**
 * Half-open time intervals [start, end) in epoch milliseconds, and the few set
 * operations the focus engine and the reports need. Pure.
 */
export interface Interval {
  start: number;
  end: number;
}

/** An interval from two instants; an open end (null) runs to `now`. */
export function span(start: Date, end: Date | null, now: Date): Interval {
  const s = start.getTime();
  const e = (end ?? now).getTime();
  return { start: s, end: Math.max(s, e) };
}

/** Sorted, merged (touching or overlapping), non-empty intervals. */
export function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/**
 * Sorted intervals with every gap of at most `gapMs` bridged (zero-length points
 * take part, so a point within `gapMs` of an interval extends it). Points left on
 * their own stay as they are; normalize() drops them.
 */
export function joinGaps(list: Interval[], gapMs: number): Interval[] {
  const sorted = list
    .filter((i) => i.end >= i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start - last.end <= gapMs) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Total length of the union, in ms. */
export function lengthMs(list: Interval[]): number {
  return normalize(list).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Intersection of two unions. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i].start, y[j].start);
    const end = Math.min(x[i].end, y[j].end);
    if (end > start) out.push({ start, end });
    if (x[i].end < y[j].end) i++;
    else j++;
  }
  return out;
}

/** `a` minus `b`. */
export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const cut = normalize(b);
  const out: Interval[] = [];
  for (const piece of normalize(a)) {
    let cursor = piece.start;
    for (const c of cut) {
      if (c.end <= cursor || c.start >= piece.end) continue;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= piece.end) break;
    }
    if (cursor < piece.end) out.push({ start: cursor, end: piece.end });
  }
  return out;
}

/** Length in ms of the overlap of one interval with a union. */
export function overlapMs(one: Interval, union: Interval[]): number {
  return lengthMs(intersect([one], union));
}

/** True when the two intervals share any time (touching ends do not count). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Whole seconds of `ms`, rounded. */
export function toSec(ms: number): number {
  return Math.round(ms / 1000);
}
