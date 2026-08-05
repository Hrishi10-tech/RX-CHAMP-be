/** Local calendar day (YYYY-MM-DD), in the server's timezone — matches presence. */
export function localDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole seconds between two instants, never negative. */
export function elapsedSeconds(from: Date, to: Date = new Date()): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/** Clamp a value into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
