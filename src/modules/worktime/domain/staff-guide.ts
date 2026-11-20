/**
 * The staff guide (3.2, fix 8): how RX Vision works, in nine short points, with
 * the organisation's own numbers filled in. The portal shows it; the agent's
 * Instructions screen reads the same text from GET /workday/guide, so a change to
 * a setting (the paid break buffer, say) shows everywhere at once.
 *
 * Changes from the 3.1 agent text: the point about signing out is gone; the
 * screenshots point no longer says "if your company turns on"; the paid time
 * point reads "your scheduled breaks plus a small buffer of N minutes are paid".
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

const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;

export function staffGuide(x: GuideNumbers): GuideItem[] {
  const items: Omit<GuideItem, 'n'>[] = [
    {
      title: 'Start your day',
      body:
        'Press Start Day when you begin work. Your focus time counts from that moment. ' +
        `Starting more than ${minutes(x.lateStartGraceMin)} after your shift starts asks you to say why.`,
    },
    {
      title: 'Breaks and the ring',
      body:
        `RX Vision rings ${minutes(x.ringLeadMin)} before each break and keeps ringing for ${minutes(x.ringDurationMin)}. ` +
        'Start your break while it rings and nothing more is needed. Starting before the ring, or after it stops, ' +
        'asks for a short reason for your manager.',
    },
    {
      title: 'Skipping a break',
      body:
        'If you cannot take a break, press Skip and say why. A break you neither take nor skip before its window ' +
        'closes is skipped for you, and you add a comment before you end the day.',
    },
    {
      title: 'Back to work',
      body:
        'Press Back to work when you return. Coming back later than your break allows asks for a reason, and you ' +
        'can ask your manager to count those minutes.',
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
        'Start a meeting when you join one, or log a meeting that already happened. Meeting time is focus time; ' +
        'your manager reviews it, and a rejected meeting comes off.',
    },
    {
      title: 'Screenshots and activity',
      body:
        'While your day is open, RX Vision notes which app is in front, whether the keyboard or mouse is in use, ' +
        'and takes screenshots every few minutes. Nothing is recorded before Start Day or after End Day.',
    },
    {
      title: 'End your day',
      body:
        'Press End Day when you finish. If you forget, RX Vision ends your day once your shift is over and there ' +
        `has been no keyboard or mouse input for ${minutes(x.forgottenEndDayIdleMin)}, and records your last input as the end time.`,
    },
    {
      title: 'Approvals, history and your calendar',
      body:
        'Your manager decides on skipped breaks, late returns and meetings. Their decisions show in your history, ' +
        'and your calendar shows your working days and holidays for the year.',
    },
  ];
  return items.map((item, i) => ({ n: i + 1, ...item }));
}
