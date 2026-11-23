import { minutes } from './fills';

/**
 * What the API says when it refuses something (brief 1.5, COPY_DECK Part B). Each message
 * lives here once, with its deck row beside it, so it reads the same at every place that
 * throws it. Clients show these words and branch on the error code, never on the words.
 *
 * Calm and brief, sentence case, "you", the next step first, no blame. Times come in already
 * formatted by `time12InZone`, break names lower case ("lunch break"). Notices have their own
 * copy modules (worktime/domain/notice-copy.ts, leave-copy.ts, wfh-copy.ts, compoff-copy.ts)
 * and the staff guide its own (worktime/domain/staff-guide.ts).
 *
 * 4.0: where the deck names "your manager", "a Super Admin" or "the Super Manager" as who
 * approves or changes something, these name who does it in 4.0: the department's managers
 * (leave/domain/routing.ts, shifts/application/break-approval.policy.ts) or the organisation
 * admin. Codes and statuses are 4.0's own, as clients already read them.
 */

const noteForManager = (minChars: number): string =>
  `Add a short note for your department's managers (${minChars} characters or more).`;

export const API_COPY = {
  // ---- Sign-in and session (deck B1) ----
  /** C-669 */
  checkCredentials: 'Check your email and password, then try again.',
  /** C-670 */
  signInPaused: (min: number): string => `Try again in ${minutes(min)}. Sign-in is paused for now.`,
  /** C-671 */
  networkSignInPaused: (min: number): string =>
    `Try again in ${minutes(min)}. Sign-in from your network is paused for now.`,
  /** C-672, C-675 (4.0: the organisation admin turns an account back on) */
  accountOff: 'Ask the organisation admin to turn your account back on.',
  /** C-673, C-674, C-676 */
  signInAgain: 'Sign in again to carry on.',
  /** C-677 */
  unavailable: "RX Vision isn't available right now. Try again in a moment.",
  /** C-678 */
  tryAgain: 'Try again in a moment.',
  /** C-679 */
  notFound: "We can't find that. Refresh and try again.",
  /** C-680 */
  alreadySaved: "That's already saved.",
  /** C-937: any route past its limit; the limit is counted per minute. */
  rateLimited: 'Try again in a minute.',

  // ---- Start day, end day and the start note (deck B2) ----
  /** C-684 */
  startNote: (time: string, minChars: number): string =>
    `Your shift started at ${time}. ${noteForManager(minChars)}`,
  /** C-685 */
  reasonTooLong: (maxChars: number): string => `Keep the reason under ${maxChars} characters.`,
  /** C-686 */
  noNoteNeeded: 'No note is needed. That day has no Start day.',
  /** C-688, C-741 */
  noteForManager,
  /** C-689 */
  dayNotFound: "We can't find that day. Refresh and try again.",
  /** C-690, C-916 */
  profileNotFound: "We can't find your profile. Sign in again.",
  /** C-691 */
  nothingToEnd: 'Start your day first. There is nothing to end yet.',
  /** C-692 */
  approvalsToDecide: (count: number, hours: number): string =>
    count === 1
      ? `Decide 1 approval in the portal to end your day. It is past ${hours} hours.`
      : `Decide ${count} approvals in the portal to end your day. They are past ${hours} hours.`,
  /** C-698 */
  dayNotStarted: 'Tap Start day first. Your day has not started.',
  /** C-699, C-767 */
  dayEnded: 'Tap Start day to carry on. Your working day has ended.',
  /** C-700 (4.0: months lock per organisation, and its admin unlocks them) */
  monthLocked: (month: string): string =>
    `Ask the organisation admin to unlock ${month}. It is locked for payroll.`,

  // ---- Breaks (deck B5) ----
  /** C-724, C-734 */
  breakNotScheduled: (name: string): string => `No ${name} is scheduled for you today.`,
  /** C-725 */
  breakAlreadyTaken: (name: string): string => `You've already taken your ${name} today.`,
  /** C-726, C-737 */
  breakOrder: (later: string, name: string): string =>
    `You've already taken your ${later}, so the ${name} is no longer available.`,
  /** C-727, C-738 */
  breakOpensAt: (name: string, time: string): string => `Your ${name} opens at ${time}.`,
  /** C-728 */
  breakWindowClosedSkipped: (name: string, time: string): string =>
    `The ${name} window closed at ${time}. It counts as skipped.`,
  /** C-739 */
  breakWindowClosed: (name: string, time: string): string =>
    `The ${name} window closed at ${time}.`,
  /** C-729 */
  breakWasDue: (name: string, time: string, minChars: number): string =>
    `Your ${name} was due at ${time}. ${noteForManager(minChars)}`,
  /** C-730 */
  breakIsDue: (name: string, time: string, minChars: number): string =>
    `Your ${name} is due at ${time}. ${noteForManager(minChars)}`,
  /** C-731 */
  breaksNextDay: 'Breaks start again with your next working day.',
  /** C-732 */
  alreadyOnBreak: "Tap Resume work first. You're already on break.",
  /** C-733 */
  overrunNote: (min: number, minChars: number): string =>
    `Add a short note to count these ${min} min (${minChars} characters or more), or leave them out.`,
  /** C-736 */
  breakHasRecord: (name: string): string => `Your ${name} already has a record today.`,
  /** C-740 */
  onBreak: "Tap Resume work first. You're on break.",
  /** C-742 */
  breakNotFound: "We can't find that break. Refresh and try again.",
  /** C-744 */
  skipHasReason: 'This skip already has a reason.',

  // ---- Meetings (deck B6) ----
  /** C-757 */
  meetingAgenda: (maxChars: number): string =>
    `Give the meeting an agenda (1 to ${maxChars} characters).`,
  /** C-758, C-905 */
  resumeBeforeMeeting: 'Tap Resume work first, then start the meeting.',
  /** C-759, C-906 */
  endMeetingFirst: 'Tap End meeting first, then start the next one.',
  /** C-760 */
  meetingNotFound: "We can't find that meeting. Refresh and try again.",
  /** C-923 */
  meetingNeedsNoApproval: 'This meeting needs no approval.',
  /** C-762 */
  pickMeetingStart: 'Pick when it started.',
  /** C-763 */
  meetingInFuture: 'Pick an earlier start or fewer minutes. That meeting ends after now.',
  /** C-764 */
  meetingOutsideDay: 'Pick a time between Start day and now.',
  /** C-765 */
  meetingOverlapsBreak: 'Pick another time. That meeting overlaps a break or lunch.',
  /** C-766 */
  meetingOverlapsMeeting: 'Pick another time. That meeting overlaps another meeting.',

  // ---- Chat, notifications and the agent download (deck B7) ----
  /** C-768 (4.0: the contacts reader's rules) */
  chatContacts: 'You can message your own team, their managers and your organisation admin.',
  /** C-769 */
  noticeNotFound: "We can't find that notice. Refresh and try again.",
  /** C-770 */
  agentNotOnServer: (platform: string): string =>
    `Try again soon. The ${platform} app isn't on the server yet.`,

  // ---- Leave and work from home (deck B8) ----
  /** C-785 */
  pickFirstDay: 'Pick a first day.',
  /** C-786 */
  pickLastDay: 'Pick a last day.',
  /** C-788 */
  pickLastDayAfterFirst: 'Pick a last day after the first day.',
  /** C-798 */
  leaveRequestNotFound: "We can't find that request. Refresh and try again.",
  /** C-801 */
  leaveStarted:
    'Ask your approver to revoke it if it should not count. This leave has already begun.',

  // ---- Avatars and gender (added after the deck was written) ----
  /** C-907 */
  avatarUnknown: 'Pick one of the avatars.',
  /** C-908 (4.0: the organisation admin sets gender) */
  avatarProfileNotSetUp:
    'Ask the organisation admin to set up your profile. Then you can choose your avatar.',
  /** C-909 */
  avatarOtherLibrary: 'You can pick from your own avatars.',
  /** C-911 */
  personNotFound: "We can't find that person. Refresh and try again.",
  /** C-912 */
  avatarNotFound: "We can't find that avatar. Refresh and try again.",
  /** C-913 (4.0: the organisation admin or a Super Admin) */
  genderSetByAdmin: 'Ask the organisation admin to set gender.',
  /** C-914 */
  genderFilterByAdmin: 'Ask the organisation admin to filter by gender.',
  /** 4.0: an avatar is reset by the organisation admin or a Super Admin. */
  avatarResetByAdmin: 'Ask the organisation admin to reset this avatar.',

  // ---- Biometric settings (added after the deck was written) ----
  /** C-915 */
  pickOnOrOff: 'Pick on or off.',

  // ---- 4.0 quick and paused breaks, in the deck's style ----
  inMeeting: "Tap End meeting first. You're in a meeting.",
  breakNotRunning: "That break isn't running. Refresh and try again.",
  quickBreakNoPause: "End the quick break instead. A quick break can't be paused.",
  breakNotPaused: "That break isn't paused. Refresh and try again.",
} as const;
