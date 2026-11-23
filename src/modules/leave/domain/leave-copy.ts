import { CATEGORY_LABEL, formatDays, LeaveCategory } from './leave.types';
import { leaveSpan } from './request-rules';

/**
 * Notification copy for leave (3.4). Short sentences naming the person, no em
 * dash, no exclamation mark (same rules as the 3.1 notices).
 */

export const LEAVE_NOTICE = {
  LEAVE_REQUESTED: 'LEAVE_REQUESTED',
  LEAVE_DECIDED: 'LEAVE_DECIDED',
  LEAVE_CANCELLED: 'LEAVE_CANCELLED',
  LEAVE_REVOKED: 'LEAVE_REVOKED',
  LEAVE_ADJUSTED: 'LEAVE_ADJUSTED',
  LEAVE_UPDATED: 'LEAVE_UPDATED',
} as const;

export interface Copy {
  title: string;
  body: string;
}

export interface CopyRequest {
  category: LeaveCategory;
  startDate: string;
  endDate: string;
  units: number;
  /** "Full day", "Half day (first half)". */
  kindLabel: string;
  reason: string;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.?]$/.test(t) ? t : `${t}.`;
}

/** "CL/SL, half day, first half", "EL/PL, 3 days". */
function what(r: CopyRequest): string {
  if (r.startDate === r.endDate && r.units < 4) {
    const kind = r.kindLabel.toLowerCase().replace(' (', ', ').replace(')', '');
    return `${CATEGORY_LABEL[r.category]}, ${kind}`;
  }
  return `${CATEGORY_LABEL[r.category]}, ${formatDays(r.units)}`;
}

/** To the approvers: a request is waiting. */
export function leaveRequestedCopy(i: { name: string; request: CopyRequest }): Copy {
  return {
    title: `Leave request: ${i.name}, ${leaveSpan(i.request.startDate, i.request.endDate)}`,
    body: `${what(i.request)}. Reason: ${sentence(i.request.reason)} Decide it in RX Vision, Leave.`,
  };
}

/** To the person: approved or rejected. */
export function leaveDecidedCopy(i: {
  request: CopyRequest;
  approved: boolean;
  byName: string;
  note: string | null;
  availableUnits: number;
}): Copy {
  const span = leaveSpan(i.request.startDate, i.request.endDate);
  const left = `You have ${formatDays(i.availableUnits)} of ${CATEGORY_LABEL[i.request.category]} left.`;
  if (i.approved) {
    return {
      title: `Leave approved: ${span}`,
      body:
        `${what(i.request)}, approved by ${i.byName}.` +
        (i.note ? ` Note: ${sentence(i.note)}` : '') +
        ` ${left}`,
    };
  }
  return {
    title: `Leave not approved: ${span}`,
    body:
      `${what(i.request)}, not approved by ${i.byName}` +
      (i.note ? `: ${sentence(i.note)}` : '.') +
      ` The days are back in your balance. ${left}`,
  };
}

/** To the approvers: approved leave was cancelled by the person. */
export function leaveCancelledCopy(i: { name: string; request: CopyRequest }): Copy {
  return {
    title: `Leave cancelled: ${i.name}, ${leaveSpan(i.request.startDate, i.request.endDate)}`,
    body: `${i.name} cancelled approved leave (${what(i.request)}). Those days are working days again.`,
  };
}

/** To the person: approved leave taken back. */
export function leaveRevokedCopy(i: {
  request: CopyRequest;
  byName: string;
  note: string;
  availableUnits: number;
}): Copy {
  const span = leaveSpan(i.request.startDate, i.request.endDate);
  return {
    title: `Leave revoked: ${span}`,
    body:
      `${i.byName} revoked your approved leave (${what(i.request)}): ${sentence(i.note)} ` +
      `The days are back in your balance and ${i.request.startDate === i.request.endDate ? 'that day is a working day' : 'those days are working days'} again. ` +
      `You have ${formatDays(i.availableUnits)} of ${CATEGORY_LABEL[i.request.category]} left.`,
  };
}

/** To the person: a manual change to a balance. */
export function leaveAdjustedCopy(i: {
  category: LeaveCategory;
  year: number;
  mode: 'ADD' | 'SUBTRACT' | 'SET';
  deltaUnits: number;
  targetUnits: number | null;
  byName: string;
  reason: string;
  balanceUnits: number;
}): Copy {
  const pool = CATEGORY_LABEL[i.category];
  if (i.mode === 'SET') {
    return {
      title: `Leave balance set: ${pool} ${formatDays(i.targetUnits ?? i.balanceUnits)}`,
      body: `${i.byName} set your ${pool} balance for ${i.year} to ${formatDays(i.targetUnits ?? i.balanceUnits)}: ${sentence(i.reason)}`,
    };
  }
  const added = i.deltaUnits > 0;
  return {
    title: `Leave balance changed: ${formatDays(i.deltaUnits, { signed: true })} ${pool}`,
    body:
      `${i.byName} ${added ? 'added' : 'took off'} ${formatDays(Math.abs(i.deltaUnits))} ${added ? 'to' : 'from'} ` +
      `your ${pool} for ${i.year}: ${sentence(i.reason)} Your ${pool} balance is now ${formatDays(i.balanceUnits)}.`,
  };
}

/** To the person: their yearly quota of a pool changed. */
export function leaveQuotaCopy(i: {
  category: LeaveCategory;
  fromUnits: number;
  toUnits: number;
  byName: string;
  year: number;
}): Copy {
  const pool = CATEGORY_LABEL[i.category];
  return {
    title: `Yearly leave changed: ${pool} ${formatDays(i.toUnits)}`,
    body:
      `${i.byName} set your ${pool} to ${formatDays(i.toUnits)} a year (it was ${formatDays(i.fromUnits)}). ` +
      `${i.year} follows it at once.`,
  };
}

/** To the person: days of approved leave given back because they became days off. */
export function leaveUpdatedCopy(i: {
  request: CopyRequest;
  givenBack: { date: string; why: string }[];
  cancelled: boolean;
}): Copy {
  const units = i.givenBack.length;
  const days = i.givenBack.map((d) => `${leaveSpan(d.date, d.date)} (${d.why})`).join(', ');
  return {
    title: i.cancelled
      ? `Leave no longer needed: ${leaveSpan(i.request.startDate, i.request.endDate)}`
      : `Leave updated: ${units === 1 ? 'a day' : `${units} days`} given back`,
    body:
      `${days} ${units === 1 ? 'is' : 'are'} no longer a working day, so ${units === 1 ? 'it is' : 'they are'} not charged as ${CATEGORY_LABEL[i.request.category]}.` +
      (i.cancelled ? ' Nothing is left of the request, so it was closed.' : ''),
  };
}
