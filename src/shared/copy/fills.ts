/** How a value reads inside a sentence, wherever that sentence lives. */

/** "1 minute", "15 minutes". */
export const minutes = (n: number): string => `${n} ${n === 1 ? 'minute' : 'minutes'}`;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-09" -> "September 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : month;
}
