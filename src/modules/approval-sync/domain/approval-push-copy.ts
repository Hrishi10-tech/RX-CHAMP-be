import { ApprovalWhat } from '@shared/events/approval-changed.event';

/**
 * The push for a new request. It shows on a lock screen, so it says what kind of
 * request is waiting and nothing else: no name, no dates, no reason.
 */
const TITLE: Record<ApprovalWhat, string> = {
  BREAK: 'A break is waiting for you',
  MEETING: 'A meeting is waiting for you',
  // 4.0: away time from the agent's pop-up.
  AWAY: 'Away time is waiting for you',
  LEAVE: 'A leave request is waiting for you',
  WFH: 'A work from home request is waiting for you',
  COMPOFF: 'A comp off claim is waiting for you',
};

export function approvalPushCopy(what: ApprovalWhat): { title: string; body: string } {
  return { title: TITLE[what], body: 'Open RX Vision to review it.' };
}
