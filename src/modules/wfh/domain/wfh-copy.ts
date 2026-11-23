import { formatDays } from '@modules/leave/domain/leave.types';
import { leaveSpan } from '@modules/leave/domain/request-rules';
import { scheduleLabelInSentence, WfhScheduleRecord, wfhWhat } from './wfh';

/**
 * Notification copy for work from home (3.5). Short sentences naming the person,
 * no em dash, no exclamation mark (the 3.1 notice rules).
 */

export const WFH_NOTICE = {
  WFH_REQUESTED: 'WFH_REQUESTED',
  WFH_DECIDED: 'WFH_DECIDED',
  WFH_CANCELLED: 'WFH_CANCELLED',
  WFH_REVOKED: 'WFH_REVOKED',
  WFH_SCHEDULED: 'WFH_SCHEDULED',
  WFH_AUTO_ENDED: 'WFH_AUTO_ENDED',
} as const;

export interface Copy {
  title: string;
  body: string;
}

export interface CopyWfh {
  startDate: string;
  endDate: string;
  units: number;
  kind: Parameters<typeof wfhWhat>[0]['kind'];
  part: Parameters<typeof wfhWhat>[0]['part'];
  reason: string;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.?]$/.test(t) ? t : `${t}.`;
}

export function wfhRequestedCopy(i: { name: string; request: CopyWfh }): Copy {
  return {
    title: `Work from home request: ${i.name}, ${leaveSpan(i.request.startDate, i.request.endDate)}`,
    body: `${wfhWhat(i.request)}. Reason: ${sentence(i.request.reason)} Decide it in RX Vision, Work from home.`,
  };
}

export function wfhDecidedCopy(i: {
  request: CopyWfh;
  approved: boolean;
  byName: string;
  note: string | null;
}): Copy {
  const span = leaveSpan(i.request.startDate, i.request.endDate);
  if (i.approved) {
    return {
      title: `Work from home approved: ${span}`,
      body:
        `${i.byName} approved ${wfhWhat(i.request).toLowerCase()}.` +
        (i.note ? ` Note: ${sentence(i.note)}` : ''),
    };
  }
  return {
    title: `Work from home not approved: ${span}`,
    body: `${i.byName} did not approve ${wfhWhat(i.request).toLowerCase()}. Note: ${sentence(i.note ?? '')}`,
  };
}

export function wfhCancelledCopy(i: { name: string; request: CopyWfh }): Copy {
  return {
    title: `Work from home cancelled: ${i.name}, ${leaveSpan(i.request.startDate, i.request.endDate)}`,
    body: `${i.name} cancelled approved ${wfhWhat(i.request).toLowerCase()}.`,
  };
}

export function wfhRevokedCopy(i: { request: CopyWfh; byName: string; note: string }): Copy {
  return {
    title: `Work from home revoked: ${leaveSpan(i.request.startDate, i.request.endDate)}`,
    body:
      `${i.byName} took back ${wfhWhat(i.request).toLowerCase()} (${formatDays(i.request.units)}). ` +
      `Note: ${sentence(i.note)}`,
  };
}

export function wfhScheduledCopy(i: {
  byName: string;
  schedule: Pick<WfhScheduleRecord, 'weekdays' | 'weeks' | 'kind' | 'part' | 'fromDate' | 'toDate'>;
  change: 'SET' | 'CHANGED' | 'ENDED';
}): Copy {
  const what = scheduleLabelInSentence(i.schedule);
  const span = i.schedule.toDate
    ? `from ${leaveSpan(i.schedule.fromDate, i.schedule.fromDate)} to ${leaveSpan(i.schedule.toDate, i.schedule.toDate)}`
    : `from ${leaveSpan(i.schedule.fromDate, i.schedule.fromDate)}`;
  if (i.change === 'ENDED') {
    return {
      title: 'Work from home schedule ended',
      body: `${i.byName} ended your work from home schedule (${what}).`,
    };
  }
  return {
    title: i.change === 'SET' ? 'Work from home schedule set' : 'Work from home schedule changed',
    body: `${i.byName} set your work from home: ${what}, ${span}. No request is needed for these days.`,
  };
}

export function wfhAutoEndedCopy(i: { endedAt: string }): Copy {
  return {
    title: 'Work from home day ended',
    body: `We ended your work from home day at ${i.endedAt}, the end of your shift.`,
  };
}
