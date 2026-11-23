import {
  BiometricStretchLite,
  IntegrationPeriodLite,
} from '@modules/worktime/domain/integration-periods.reader';
import { BIOMETRIC_SOURCE, MOBILE_WFH_SOURCE } from '@modules/worktime/domain/day';
import { monthTotals } from './report-builder';
import { MonthTotals, PersonDaySummary, PersonMonthReport, PersonPayroll } from './report.types';

/**
 * The payroll pause for biometric staff (brief 1.6), as pure functions.
 *
 * A biometric person's payroll for a day is calculated only if the biometric integration
 * was on that day. Switching it on resumes from that day (the whole day counts); earlier
 * days stay paused, since past periods are never worked out again by themselves. Tracking
 * is untouched: days, punches and focus time read as they always did. Nobody else is
 * affected: a day that is not paused comes out exactly as it did before.
 */

/** Shown wherever a paused person's payroll would appear. */
export const PAYROLL_PAUSED_LABEL = 'Payroll paused · biometric integration pending';

/** Whether the integration was on at any moment of this business day. */
export function integrationWasOn(periods: readonly IntegrationPeriodLite[], date: string): boolean {
  return periods.some((p) => p.fromDate <= date && (p.toDate === null || date <= p.toDate));
}

/**
 * Whether the day is recorded by the biometric device: the source in force on that date, so a
 * later change of source never recalculates it.
 *
 * The person's current source applies from the day it last changed, and their earlier stretches
 * on biometric to the day each ended. The sessions decide the rest. From the day someone moved
 * back to the agent, only a day made wholly of punches or work from home on the phone counts:
 * their agent hours that day are calculated. Before it (a move made before these stretches were
 * kept), any such session does.
 */
export function isBiometricDay(
  person: { attendanceSource?: 'AGENT' | 'BIOMETRIC'; attendanceSourceFrom?: string | null },
  date: string,
  sessions: readonly { source: string }[],
  earlier: readonly BiometricStretchLite[] = [],
): boolean {
  const from = person.attendanceSourceFrom ?? null;
  const sinceChange = !from || date >= from;
  if (sinceChange && person.attendanceSource === 'BIOMETRIC') return true;
  if (earlier.some((s) => (s.fromDate === null || s.fromDate <= date) && date <= s.toDate)) {
    return true;
  }
  const fromPunches = (s: { source: string }) =>
    s.source === BIOMETRIC_SOURCE || s.source === MOBILE_WFH_SOURCE;
  return from && sinceChange
    ? sessions.length > 0 && sessions.every(fromPunches)
    : sessions.some(fromPunches);
}

/** Days before someone joined, or off and not worked, give payroll nothing to count. */
function givesPayrollSomething(d: PersonDaySummary): boolean {
  return d.workday || d.startedAt !== null || d.focusSec > 0;
}

/** One person's payroll standing for a month; null with no paused day (nearly everyone). */
export function payrollOf(
  days: readonly PersonDaySummary[],
  today: string,
  quietHoursFlag: number,
): PersonPayroll | null {
  const soFar = days.filter((d) => d.date <= today);
  const flagged = soFar.filter((d) => d.payrollPaused);
  if (!flagged.length) return null;
  const counted = soFar.some((d) => !d.payrollPaused && givesPayrollSomething(d));
  const leftOut = flagged.filter(givesPayrollSomething);
  // Only a weekly off or a holiday is flagged and the rest is calculated: nothing is left out.
  if (!leftOut.length && counted) return null;
  // Nothing calculated yet and nothing to leave out (the 1st is a Sunday): still labelled.
  const paused = leftOut.length ? leftOut : flagged;
  return {
    paused: !counted,
    label: PAYROLL_PAUSED_LABEL,
    pausedDays: paused.length,
    pausedFrom: paused[0].date,
    pausedTo: paused[paused.length - 1].date,
    totals: monthTotals(
      days.filter((d) => !d.payrollPaused),
      today,
      quietHoursFlag,
    ),
  };
}

/** What a person's month adds to payroll: the days calculated, and their totals. */
export function payrollPartOf(p: Pick<PersonMonthReport, 'totals' | 'days' | 'payroll'>): {
  totals: MonthTotals;
  days: PersonDaySummary[];
} {
  return p.payroll
    ? { totals: p.payroll.totals, days: p.days.filter((d) => !d.payrollPaused) }
    : { totals: p.totals, days: p.days };
}

/** The people a payroll run counts: everyone with at least one day calculated. */
export function inPayroll<T extends Pick<PersonMonthReport, 'payroll'>>(persons: T[]): T[] {
  return persons.filter((p) => !p.payroll?.paused);
}
