import { minutes } from '@shared/copy/fills';

/**
 * The staff guide (3.2, fix 8): how RX Vision works, in nine short points, with
 * the organisation's own numbers filled in. The portal shows it; the agent's
 * Instructions screen reads the same text from GET /workday/guide, so a change to
 * a setting (the paid break buffer, say) shows everywhere at once.
 *
 * Changes from the 3.1 agent text: the point about signing out is gone; the
 * screenshots point no longer says "if your company turns on"; the paid time
 * point reads "your scheduled breaks plus a small buffer of N minutes are paid".
 * 3.6: the wording of brief 1.5 (COPY_DECK B3, rows C-701 to C-718).
 */

export interface GuideItem {
  n: number;
  title: string;
  body: string;
}

export interface GuideNumbers {
  paidBreakBufferMin: number;
  lateStartGraceMin: number;
  forgottenEndDayIdleMin: number;
  ringLeadMin: number;
  ringDurationMin: number;
}

/** `fileTransfers`: the red flags feature is on, so the guide names what it records (C-917). */
export function staffGuide(x: GuideNumbers, opts: { fileTransfers: boolean }): GuideItem[] {
  const items: Omit<GuideItem, 'n'>[] = [
    {
      title: 'Start your day',
      body:
        'Tap Start day when you begin work. Your focus time counts from that moment. ' +
        `Starting more than ${minutes(x.lateStartGraceMin)} after your shift starts asks for a short note.`,
    },
    {
      title: 'Breaks and reminders',
      body:
        `A small badge on the icon shows ${minutes(x.ringLeadMin)} before each break. ` +
        `Start your break in the next ${minutes(x.ringDurationMin)} and nothing more is needed. ` +
        "Starting before or after that asks for a short note for your department's managers.",
    },
    {
      title: 'Skipping a break',
      body:
        'If you cannot take a break, tap Skip this break and add a short note. A break you neither take nor skip ' +
        'before its window closes is skipped for you, and you add a comment before you end the day.',
    },
    {
      title: 'Resume work',
      body:
        'Tap Resume work when you return. If your break runs over, add a short note and you can ask your ' +
        "department's managers to count those minutes.",
    },
    {
      title: 'Paid time',
      body:
        'Your focus time is paid. Your scheduled breaks plus a small buffer of ' +
        `${minutes(x.paidBreakBufferMin)} are paid. Break time beyond that is not.`,
    },
    {
      title: 'Meetings',
      body:
        'Tap Start meeting when you join one and End meeting when it finishes. Time marked In a meeting needs no ' +
        'approval and always counts as working and focus time. You can also log a meeting that already happened; ' +
        "your department's managers review those.",
    },
    {
      title: 'Screenshots and activity',
      body: `While your day is open, RX Vision notes which app is in front, whether the keyboard or mouse is in use${
        opts.fileTransfers ? ' and any file-transfer events' : ''
      }, and takes screenshots every few minutes. Nothing is recorded before Start day or after End day.`,
    },
    {
      title: 'End your day',
      body:
        'Tap End day when you finish. If it slips your mind, RX Vision ends your day once your shift is over and ' +
        `there has been no keyboard or mouse input for ${minutes(x.forgottenEndDayIdleMin)}, and records your last input as the end time.`,
    },
    {
      title: 'Approvals, history and your calendar',
      body:
        "Your department's managers decide on skipped breaks, extended breaks and logged meetings. Their decisions show in your history, " +
        'and your calendar shows your working days and holidays for the year.',
    },
  ];
  return items.map((item, i) => ({ n: i + 1, ...item }));
}
