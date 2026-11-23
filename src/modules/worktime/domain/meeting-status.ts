/**
 * The "In a meeting" status (brief 1.8, D-20, D-22), as pure functions.
 *
 * A status meeting carries only its start and end. After 2 hours the agent asks "Still in a
 * meeting?"; no answer within 10 minutes switches the person back to Working, at exactly
 * that moment. Each "Still in it" starts the 2 hours again.
 */

/** How long a status meeting runs before the agent asks whether it still is one. */
export const STATUS_MEETING_PROMPT_MS = 2 * 60 * 60_000;
/** How long the question waits for an answer. */
export const STATUS_MEETING_FALLBACK_MS = 10 * 60_000;
/** Longest a status meeting can go unconfirmed. */
export const STATUS_MEETING_UNCONFIRMED_MS = STATUS_MEETING_PROMPT_MS + STATUS_MEETING_FALLBACK_MS;

/** What old clients read as the agenda of a meeting that has none (nothing is stored). */
export const STATUS_MEETING_LABEL = 'In a meeting';

export type StatusStartSource = 'BUTTON' | 'SUGGESTION';
export const STATUS_START_SOURCES: readonly StatusStartSource[] = ['BUTTON', 'SUGGESTION'];

export type MeetingKind = 'DECLARED' | 'STATUS';
export type MeetingEndReason = 'USER' | 'BREAK' | 'END_DAY' | 'NO_ANSWER' | 'AUTO_CLOSED';

/** When the agent asks "Still in a meeting?". */
export function statusPromptAt(confirmedAt: Date): Date {
  return new Date(confirmedAt.getTime() + STATUS_MEETING_PROMPT_MS);
}

/** When an unanswered question switches the person back to Working. */
export function statusFallbackAt(confirmedAt: Date): Date {
  return new Date(confirmedAt.getTime() + STATUS_MEETING_UNCONFIRMED_MS);
}

/** The last confirmation that is still in time at `now`: anything at or before it is overdue. */
export function statusCutoff(now: Date): Date {
  return new Date(now.getTime() - STATUS_MEETING_UNCONFIRMED_MS);
}

/** The question went unanswered: the fallback moment has come. */
export function statusFallbackDue(confirmedAt: Date, now: Date): boolean {
  return now.getTime() >= statusFallbackAt(confirmedAt).getTime();
}
