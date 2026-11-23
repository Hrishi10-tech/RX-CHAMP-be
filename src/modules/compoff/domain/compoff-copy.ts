import { formatDays } from '@modules/leave/domain/leave.types';
import { leaveDay } from '@modules/leave/domain/request-rules';

/** Notification copy for comp off (3.5): short sentences, no em dash, no exclamation mark. */

export const COMPOFF_NOTICE = {
  COMPOFF_CLAIMED: 'COMPOFF_CLAIMED',
  COMPOFF_DECIDED: 'COMPOFF_DECIDED',
  COMPOFF_CREDITED: 'COMPOFF_CREDITED',
  COMPOFF_EXPIRING: 'COMPOFF_EXPIRING',
} as const;

export interface Copy {
  title: string;
  body: string;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.?]$/.test(t) ? t : `${t}.`;
}

export function claimedCopy(i: {
  name: string;
  workedDate: string;
  dayLabel: string;
  workedLabel: string;
  units: number;
  reason: string;
}): Copy {
  return {
    title: `Comp off claim: ${i.name}, ${leaveDay(i.workedDate)}`,
    body:
      `${i.name} worked on ${leaveDay(i.workedDate)} (${i.dayLabel.toLowerCase()}), ${i.workedLabel}, and asks for ` +
      `${formatDays(i.units)} of comp off. Reason: ${sentence(i.reason)} Decide it in RX Vision, Leave, Comp off.`,
  };
}

export function decidedCopy(i: {
  workedDate: string;
  approved: boolean;
  byName: string;
  askedUnits: number;
  units: number;
  expiresOn: string | null;
  note: string | null;
}): Copy {
  const day = leaveDay(i.workedDate);
  if (!i.approved) {
    return {
      title: `Comp off not approved: ${day}`,
      body: `${i.byName} did not approve your comp off claim for ${day}. Note: ${sentence(i.note ?? '')}`,
    };
  }
  const less = i.units < i.askedUnits ? ` (you asked for ${formatDays(i.askedUnits)})` : '';
  return {
    title: `Comp off approved: ${formatDays(i.units)} for ${day}`,
    body:
      `${i.byName} approved ${formatDays(i.units)} of comp off for ${day}${less}. ` +
      (i.expiresOn ? `Take it by ${leaveDay(i.expiresOn)}.` : '') +
      (i.note ? ` Note: ${sentence(i.note)}` : ''),
  };
}

export function creditedCopy(i: {
  workedDate: string;
  byName: string;
  units: number;
  expiresOn: string;
  reason: string;
}): Copy {
  return {
    title: `Comp off credited: ${formatDays(i.units)}`,
    body:
      `${i.byName} credited ${formatDays(i.units)} of comp off for ${leaveDay(i.workedDate)}. ` +
      `Take it by ${leaveDay(i.expiresOn)}. Reason: ${sentence(i.reason)}`,
  };
}

export function revokedCopy(i: {
  workedDate: string;
  byName: string;
  units: number;
  note: string;
}): Copy {
  return {
    title: `Comp off taken back: ${leaveDay(i.workedDate)}`,
    body: `${i.byName} took back ${formatDays(i.units)} of comp off for ${leaveDay(i.workedDate)}. Note: ${sentence(i.note)}`,
  };
}

export function expiringCopy(i: { units: number; expiresOn: string; workedDate: string }): Copy {
  return {
    title: `Take your comp off by ${leaveDay(i.expiresOn)}`,
    body:
      `Apply for it in RX Vision, Leave. ${formatDays(i.units)} of comp off for ${leaveDay(i.workedDate)} ` +
      `is not taken yet and lapses after ${leaveDay(i.expiresOn)}.`,
  };
}
