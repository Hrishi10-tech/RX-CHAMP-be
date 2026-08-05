/**
 * The local calendar day (YYYY-MM-DD) used to group sessions day-wise.
 * Uses the server's local timezone so an office day lines up with the wall clock.
 */
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
