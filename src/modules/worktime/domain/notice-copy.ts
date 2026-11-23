import { RecordKind, RECORD_LABEL } from '@modules/shifts/domain/shift.types';
import { minutes, monthName } from '@shared/copy/fills';

/**
 * Titles and bodies of the 3.1 notifications (SPEC 3.10). Short sentences naming
 * the person; no em dash, no exclamation mark; times already formatted by `time12InZone`
 * ("1:45 PM"). Wording: brief 1.5, COPY_DECK B9 and B10.
 */

export const NOTICE = {
  SKIP_REQUESTED: 'SKIP_REQUESTED',
  AUTO_SKIP_REQUESTED: 'AUTO_SKIP_REQUESTED',
  SKIP_COMMENT_ADDED: 'SKIP_COMMENT_ADDED',
  MEETING_REQUESTED: 'MEETING_REQUESTED',
  MEETING_DECIDED: 'MEETING_DECIDED',
  APPROVALS_DUE_SOON: 'APPROVALS_DUE_SOON',
  APPROVALS_OVERDUE: 'APPROVALS_OVERDUE',
  APPROVALS_ESCALATED: 'APPROVALS_ESCALATED',
  MONTHLY_REPORT_READY: 'MONTHLY_REPORT_READY',
  DAY_AUTO_CLOSED: 'DAY_AUTO_CLOSED',
  AWAY_REQUESTED: 'AWAY_REQUESTED',
  AWAY_DECIDED: 'AWAY_DECIDED',
  FOCUS_ADJUSTED: 'FOCUS_ADJUSTED',
  LATE_START_REASON: 'LATE_START_REASON',
} as const;

export interface Copy {
  title: string;
  body: string;
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-13" -> "13 Oct". */
export function shortDay(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d} ${SHORT[m - 1]}` : dateKey;
}

function lowerLabel(kind: RecordKind | null): string {
  return kind ? RECORD_LABEL[kind].toLowerCase() : 'break';
}

/** "1 approval is", "3 approvals are". */
function approvalsAre(n: number): string {
  return n === 1 ? '1 approval is' : `${n} approvals are`;
}

/** "Maya", "Maya and Arjun", "Maya, Arjun and 2 others". */
export function namesList(names: string[]): string {
  const unique = [...new Set(names.filter((n) => n.trim().length))];
  if (unique.length === 0) return 'the Admin';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  if (unique.length === 3) return `${unique[0]}, ${unique[1]} and ${unique[2]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} others`;
}

/** C-865: a request with no note from the person yet. */
export const NO_NOTE_YET = 'Review it in Approvals. No note yet.';

/** Ends free text with a full stop unless it already ends a sentence. */
export function asSentence(text: string): string {
  const t = text.trim();
  return /[.?]$/.test(t) ? t : `${t}.`;
}

export function skipRequestedCopy(p: {
  name: string;
  kind: RecordKind | null;
  reason: string | null;
}): Copy {
  return {
    title: `${p.name} skipped the ${lowerLabel(p.kind)}`,
    body: p.reason ? `Reason: ${asSentence(p.reason)} Review it in Approvals.` : NO_NOTE_YET,
  };
}

export function autoSkipRequestedCopy(p: {
  name: string;
  kind: RecordKind | null;
  at: string;
}): Copy {
  return {
    title: `${p.name}'s ${lowerLabel(p.kind)} was skipped automatically`,
    body: `No break was taken by ${p.at}. Review it in Approvals.`,
  };
}

export function skipCommentCopy(p: {
  name: string;
  kind: RecordKind | null;
  date: string;
  comment: string;
}): Copy {
  return {
    title: `${p.name} commented on the skipped ${lowerLabel(p.kind)}`,
    body: `${shortDay(p.date)}: ${p.comment}`,
  };
}

export function meetingRequestedCopy(p: {
  name: string;
  agenda: string;
  minutes: number;
  from: string;
  to: string;
}): Copy {
  return {
    title: `${p.name} logged a meeting: ${p.agenda}`,
    body: `${p.minutes} min, ${p.from} to ${p.to}. Review it in Approvals.`,
  };
}

export function meetingDecidedCopy(p: {
  approved: boolean;
  date: string;
  deciderName: string;
  note: string | null;
}): Copy {
  return {
    title: `Your meeting on ${shortDay(p.date)} was ${p.approved ? 'approved' : 'not approved'}`,
    body: p.note ? `${p.deciderName}: ${p.note}` : `By ${p.deciderName}.`,
  };
}

export function dueSoonCopy(count: number): Copy {
  return {
    title: `${approvalsAre(count)} due within 12 hours`,
    body: 'Decide them in Approvals before they go to the organisation admin.',
  };
}

export function overdueCopy(count: number, slaHours: number): Copy {
  return {
    title: `${approvalsAre(count)} past ${slaHours} hours`,
    body: 'Decide them in Approvals. They now show for the organisation admin too.',
  };
}

export function escalatedCopy(count: number, slaHours: number, approverNames: string[]): Copy {
  return {
    title: `${approvalsAre(count)} past ${slaHours} hours`,
    body: `Waiting on ${namesList(approverNames)}. You can decide them in Approvals.`,
  };
}

export function monthlyReportCopy(month: string, scope: 'TEAM' | 'ALL'): Copy {
  return {
    title: `${monthName(month)} report is ready`,
    body:
      scope === 'ALL'
        ? "Everyone's monthly report is ready in Reports."
        : "Your team's monthly report is ready in Reports.",
  };
}

/**
 * What set the moment of an automatic close: the last keyboard or mouse input (null), or a
 * status meeting (D-22), still running at the hard stop or ended with no input after it.
 */
export type AutoCloseMeeting = 'RUNNING' | 'ENDED' | null;

/** C-813, C-814; a status meeting: C-919, C-920. */
export function dayAutoClosedSelfCopy(p: { closedAt: string; meeting?: AutoCloseMeeting }): Copy {
  const body =
    p.meeting === 'RUNNING'
      ? "Tap Start day if you're still working. Your meeting time up to then counts."
      : p.meeting === 'ENDED'
        ? 'We closed it at the end of your meeting.'
        : 'We closed it at your last keyboard or mouse input.';
  return { title: `Your day was closed for you at ${p.closedAt}`, body };
}

/** C-884, C-885; a status meeting: C-921, C-922. */
export function dayAutoClosedManagerCopy(p: {
  name: string;
  closedAt: string;
  meeting?: AutoCloseMeeting;
}): Copy {
  const body =
    p.meeting === 'RUNNING'
      ? `They were in a meeting. The day was closed at ${p.closedAt}, and that time counts.`
      : p.meeting === 'ENDED'
        ? `The day was closed at the end of their meeting, ${p.closedAt}.`
        : `The day was closed at the last input, ${p.closedAt}.`;
  return { title: `${p.name}'s day was closed automatically`, body };
}

/** To the person whose focus time the Super Manager changed by hand (3.3). */
export function focusAdjustedCopy(i: {
  date: string;
  deltaSec: number;
  reason: string;
  voided: boolean;
}): Copy {
  const min = Math.round(Math.abs(i.deltaSec) / 60);
  const amount = minutes(min);
  const day = shortDay(i.date);
  if (i.voided) {
    return {
      title: `Adjustment undone: ${day}`,
      body:
        `The ${amount} ${i.deltaSec < 0 ? 'taken off' : 'added to'} your focus time for ${day} ` +
        `${min === 1 ? 'has' : 'have'} been undone. That day is back to what the app recorded.`,
    };
  }
  return {
    title: `Focus time adjusted: ${day}`,
    body:
      `The Super Manager ${i.deltaSec < 0 ? `took ${amount} off` : `added ${amount} to`} ` +
      `your focus time for ${day}: ${i.reason}`,
  };
}

/**
 * To the person (3.2): a late start with no reason yet, from an agent that cannot ask. C-815,
 * C-816 in 4.0's words: Staff do not use the portal, and their department's managers read it.
 */
export function lateStartReasonCopy(i: { graceMin: number }): Copy {
  return {
    title: 'Add a note about your start today',
    body:
      "Let your department's managers know why. Updating RX Vision on this computer lets it " +
      'ask you next time. ' +
      `Your day started more than ${minutes(i.graceMin)} after your shift start.`,
  };
}
