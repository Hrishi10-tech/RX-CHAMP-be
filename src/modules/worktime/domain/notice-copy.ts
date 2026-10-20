import { RecordKind, RECORD_LABEL } from '@modules/shifts/domain/shift.types';

/**
 * Titles and bodies of the 3.1 notifications (SPEC 3.10). Short sentences naming
 * the person; no em dash, no exclamation mark; times already formatted HH:MM.
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
} as const;

export interface Copy {
  title: string;
  body: string;
}

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
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09" -> "September 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : month;
}

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
    body: p.reason
      ? `Reason: ${asSentence(p.reason)} Review it in Approvals.`
      : 'No reason given. Review it in Approvals.',
  };
}

export function autoSkipRequestedCopy(p: {
  name: string;
  kind: RecordKind | null;
  at: string;
}): Copy {
  return {
    title: `${p.name}'s ${lowerLabel(p.kind)} was auto-skipped`,
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
    title: `Your meeting on ${shortDay(p.date)} was ${p.approved ? 'approved' : 'rejected'}`,
    body: p.note ? `${p.deciderName}: ${p.note}` : `By ${p.deciderName}.`,
  };
}

export function dueSoonCopy(count: number): Copy {
  return {
    title: `${approvalsAre(count)} due within 12 hours`,
    body: "Decide them in Approvals before they go to your organisation's Admin.",
  };
}

export function overdueCopy(count: number, slaHours: number): Copy {
  return {
    title: `${approvalsAre(count)} past ${slaHours} hours`,
    body: "Your organisation's Admin has been told. Decide them in Approvals.",
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

export function dayAutoClosedSelfCopy(p: { closedAt: string }): Copy {
  return {
    title: `Your day was closed at ${p.closedAt}`,
    body: 'End Day was not pressed, so the day was closed at your last keyboard or mouse input.',
  };
}

export function dayAutoClosedManagerCopy(p: { name: string; closedAt: string }): Copy {
  return {
    title: `${p.name}'s day was closed automatically`,
    body: `End Day was not pressed. The day was closed at the last input, ${p.closedAt}.`,
  };
}
