import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { approvalPushCopy } from '@modules/approval-sync/domain/approval-push-copy';
import {
  noCheckoutManagerCopy,
  noCheckoutSelfCopy,
} from '@modules/biometric/domain/biometric-copy';
import {
  claimedCopy,
  creditedCopy,
  decidedCopy,
  expiringCopy,
  revokedCopy,
} from '@modules/compoff/domain/compoff-copy';
import {
  CopyRequest,
  leaveAdjustedCopy,
  leaveCancelledCopy,
  leaveDecidedCopy,
  leaveQuotaCopy,
  leaveRequestedCopy,
  leaveRevokedCopy,
  leaveUpdatedCopy,
} from '@modules/leave/domain/leave-copy';
import { alreadyStatus, STATUS_LABEL } from '@modules/leave/domain/leave.types';
import { AgentActivatedSubscriber } from '@modules/notifications/application/agent-activated.subscriber';
import {
  BreakEventsSubscriber,
  effectSentence,
} from '@modules/notifications/application/break-events.subscriber';
import { ChatMessageSubscriber } from '@modules/notifications/application/chat-message.subscriber';
import { CompanyAssignedSubscriber } from '@modules/notifications/application/company-assigned.subscriber';
import { DayEndedSubscriber } from '@modules/notifications/application/day-ended.subscriber';
import { MeetingNoteSharedSubscriber } from '@modules/notifications/application/meeting-note-shared.subscriber';
import { DEFAULT_REASON_PRESETS, PRESET_KINDS } from '@modules/settings/domain/reason-presets';
import { BreakApprovalRequestedEvent } from '@modules/shifts/domain/events/break-approval-requested.event';
import { BreakDecidedEvent } from '@modules/shifts/domain/events/break-decided.event';
import {
  CopyWfh,
  wfhAutoEndedCopy,
  wfhCancelledCopy,
  wfhDecidedCopy,
  wfhRequestedCopy,
  wfhRevokedCopy,
  wfhScheduledCopy,
} from '@modules/wfh/domain/wfh-copy';
import { wfhDayView } from '@modules/worktime/application/workday.service';
import {
  breakDetail,
  BreakTextInput,
  meetingDetail,
  ownBreakTitle,
} from '@modules/worktime/domain/approval-copy';
import { ApprovalsDigestEvent } from '@modules/worktime/domain/events/approvals-digest.event';
import {
  autoSkipRequestedCopy,
  dayAutoClosedManagerCopy,
  dayAutoClosedSelfCopy,
  dueSoonCopy,
  escalatedCopy,
  focusAdjustedCopy,
  lateStartReasonCopy,
  meetingDecidedCopy,
  meetingRequestedCopy,
  monthlyReportCopy,
  overdueCopy,
  skipCommentCopy,
  skipRequestedCopy,
} from '@modules/worktime/domain/notice-copy';
import { STATUS_MEETING_LABEL } from '@modules/worktime/domain/meeting-status';
import { staffGuide } from '@modules/worktime/domain/staff-guide';
import { PAYROLL_PAUSED_LABEL } from '@modules/reports/domain/payroll-pause';
import {
  InvalidCredentialsError,
  NotFoundError,
  UnauthorizedError,
} from '../exceptions/app.exception';
import { attendanceByBiometric } from '../exceptions/attendance-by-biometric';
import { monthLockedError } from '../database/month-lock';
import { Role } from '../rbac/roles.enum';
import { API_COPY } from './api-copy';

/**
 * Brief 1.5: the words people read, held to its rules (COPY_DECK Part B, rows C-669 to C-904,
 * and the rows added after the deck was written). Each check reads the constant or the function
 * the code itself uses; what stays inline in a service is covered by the scan of the sources,
 * which reads what TypeScript parses: ternaries, text after a plus and `message:` included.
 */

const BLAME = /\b(violations?|warnings?|late|overdue|failed|idle)\b/i;
/** Short forms that are not shouting: the product, the clock, the leave pools. */
const CAPITALS_ALLOWED = new Set(['RX', 'AM', 'PM', 'CL', 'SL', 'EL', 'PL']);
/**
 * Also not shouting in the refusals of admin screens and imports, the only place they are named:
 * formats (YYYY-MM-DD HH:MM, MB, CSV, URL, PNG, JPEG), the values a field takes, ID, a locale.
 */
const INLINE_CAPITALS_ALLOWED = new Set([
  ...CAPITALS_ALLOWED,
  'YYYY',
  'MM',
  'DD',
  'HH',
  'MB',
  'CSV',
  'URL',
  'PNG',
  'JPEG',
  'ID',
  'IN',
  'OUT',
  'AGENT',
  'BIOMETRIC',
  'GENERIC',
  'BIOTIME',
  'SPAN',
  'PAIRS',
  'MANAGER',
  'EXPECTED',
  'US',
  // 4.0: the values of a sign-out key's scope and of a person's role.
  'USER',
  'USERS',
  'DEPARTMENTS',
  'ORG',
]);

/** What breaks the rules that hold for every message the API writes. */
function brokenTone(text: string): string[] {
  const broken: string[] = [];
  if (text.includes('!')) broken.push('exclamation mark');
  if (text.includes('\u2014')) broken.push('em dash');
  const blame = BLAME.exec(text);
  if (blame) broken.push(`the word "${blame[1]}"`);
  return broken;
}

/** What breaks brief 1.5 in `text`, or nothing. */
function brokenRules(text: string, allowed: Set<string> = CAPITALS_ALLOWED): string[] {
  const broken = brokenTone(text);
  for (const word of text.match(/\b[A-Z]{2,}\b/g) ?? []) {
    if (!allowed.has(word)) broken.push(`capitals: ${word}`);
  }
  if (/\b(Start Day|End Day)\b/.test(text)) broken.push('not sentence case');
  return broken;
}

function rendered(value: unknown): string {
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => string)(...Array<unknown>(value.length).fill(2))
    : (value as string);
}

const GUIDE_NUMBERS = {
  paidBreakBufferMin: 10,
  lateStartGraceMin: 15,
  forgottenEndDayIdleMin: 30,
  ringLeadMin: 2,
  ringDurationMin: 5,
};

const LEAVE: CopyRequest = {
  category: 'CLSL',
  startDate: '2026-11-09',
  endDate: '2026-11-13',
  units: 20,
  kindLabel: 'Full day',
  reason: 'Family function',
};

const WFH: CopyWfh = {
  startDate: '2026-11-09',
  endDate: '2026-11-09',
  units: 4,
  kind: 'FULL_DAY',
  part: null,
  reason: 'Delivery at home',
};

const SCHEDULE = {
  weekdays: [1, 3],
  weeks: [] as number[],
  kind: 'FULL_DAY' as const,
  part: null,
  fromDate: '2026-11-09',
  toDate: null,
};

/** Every notice as the copy modules write it, each with all its forms. */
const NOTICES = [
  skipRequestedCopy({ name: 'Asha Rao', kind: 'MORNING', reason: 'Client call' }),
  skipRequestedCopy({ name: 'Asha Rao', kind: 'MORNING', reason: null }),
  autoSkipRequestedCopy({ name: 'Asha Rao', kind: 'LUNCH', at: '2:00 PM' }),
  skipCommentCopy({ name: 'Asha Rao', kind: 'EVENING', date: '2026-11-09', comment: 'On a call' }),
  meetingRequestedCopy({
    name: 'Asha Rao',
    agenda: 'Review',
    minutes: 45,
    from: '10:00 AM',
    to: '10:45 AM',
  }),
  meetingDecidedCopy({ approved: true, date: '2026-11-09', deciderName: 'Bala K', note: null }),
  meetingDecidedCopy({ approved: false, date: '2026-11-09', deciderName: 'Bala K', note: 'No' }),
  dueSoonCopy(1),
  dueSoonCopy(3),
  overdueCopy(1, 48),
  overdueCopy(3, 48),
  escalatedCopy(3, 48, ['Bala K']),
  monthlyReportCopy('2026-10', 'ALL'),
  monthlyReportCopy('2026-10', 'TEAM'),
  dayAutoClosedSelfCopy({ closedAt: '6:30 PM' }),
  dayAutoClosedSelfCopy({ closedAt: '6:30 PM', meeting: 'RUNNING' }),
  dayAutoClosedSelfCopy({ closedAt: '6:30 PM', meeting: 'ENDED' }),
  dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: '6:30 PM' }),
  dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: '6:30 PM', meeting: 'RUNNING' }),
  dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: '6:30 PM', meeting: 'ENDED' }),
  lateStartReasonCopy({ graceMin: 15 }),
  focusAdjustedCopy({ date: '2026-11-09', deltaSec: 1800, reason: 'Power cut', voided: false }),
  focusAdjustedCopy({ date: '2026-11-09', deltaSec: -1800, reason: 'Power cut', voided: false }),
  focusAdjustedCopy({ date: '2026-11-09', deltaSec: 1800, reason: 'Power cut', voided: true }),
  noCheckoutSelfCopy({ day: 'Mon 9 Nov', at: '6:30 PM' }),
  noCheckoutManagerCopy({ name: 'Asha Rao', day: 'Mon 9 Nov', at: '6:30 PM' }),
  leaveRequestedCopy({ name: 'Asha Rao', request: LEAVE }),
  leaveDecidedCopy({
    request: LEAVE,
    approved: true,
    byName: 'Bala K',
    note: 'Enjoy',
    availableUnits: 30,
  }),
  leaveDecidedCopy({
    request: LEAVE,
    approved: false,
    byName: 'Bala K',
    note: 'Release week',
    availableUnits: 30,
  }),
  leaveDecidedCopy({
    request: LEAVE,
    approved: false,
    byName: 'Bala K',
    note: null,
    availableUnits: 30,
  }),
  leaveCancelledCopy({ name: 'Asha Rao', request: LEAVE }),
  leaveRevokedCopy({ request: LEAVE, byName: 'Bala K', note: 'Audit', availableUnits: 30 }),
  leaveAdjustedCopy({
    category: 'ELPL',
    year: 2026,
    mode: 'SET',
    deltaUnits: 0,
    targetUnits: 26,
    byName: 'Bala K',
    reason: 'Opening balance',
    balanceUnits: 26,
  }),
  leaveAdjustedCopy({
    category: 'ELPL',
    year: 2026,
    mode: 'ADD',
    deltaUnits: 4,
    targetUnits: null,
    byName: 'Bala K',
    reason: 'Opening balance',
    balanceUnits: 26,
  }),
  leaveQuotaCopy({ category: 'CLSL', fromUnits: 48, toUnits: 60, byName: 'Bala K', year: 2026 }),
  leaveUpdatedCopy({
    request: LEAVE,
    givenBack: [{ date: '2026-11-10', why: 'Founders Day' }],
    cancelled: false,
  }),
  leaveUpdatedCopy({
    request: LEAVE,
    givenBack: [
      { date: '2026-11-09', why: 'Founders Day' },
      { date: '2026-11-10', why: 'Founders Day' },
    ],
    cancelled: true,
  }),
  wfhRequestedCopy({ name: 'Asha Rao', request: WFH }),
  wfhDecidedCopy({ request: WFH, approved: true, byName: 'Bala K', note: null }),
  wfhDecidedCopy({ request: WFH, approved: false, byName: 'Bala K', note: 'Client visit' }),
  wfhCancelledCopy({ name: 'Asha Rao', request: WFH }),
  wfhRevokedCopy({ request: WFH, byName: 'Bala K', note: 'Audit' }),
  wfhScheduledCopy({ byName: 'Bala K', schedule: SCHEDULE, change: 'SET' }),
  wfhScheduledCopy({ byName: 'Bala K', schedule: SCHEDULE, change: 'CHANGED' }),
  wfhScheduledCopy({ byName: 'Bala K', schedule: SCHEDULE, change: 'ENDED' }),
  wfhAutoEndedCopy({ endedAt: '6:30 PM' }),
  claimedCopy({
    name: 'Asha Rao',
    workedDate: '2026-11-08',
    dayLabel: 'Weekly off',
    workedLabel: '7h 00m',
    units: 4,
    reason: 'Release',
  }),
  decidedCopy({
    workedDate: '2026-11-08',
    approved: true,
    byName: 'Bala K',
    askedUnits: 4,
    units: 2,
    expiresOn: '2027-02-08',
    note: 'Half is fine',
  }),
  decidedCopy({
    workedDate: '2026-11-08',
    approved: false,
    byName: 'Bala K',
    askedUnits: 4,
    units: 0,
    expiresOn: null,
    note: 'No release that day',
  }),
  creditedCopy({
    workedDate: '2026-11-08',
    byName: 'Bala K',
    units: 4,
    expiresOn: '2027-02-08',
    reason: 'Go-live',
  }),
  revokedCopy({ workedDate: '2026-11-08', byName: 'Bala K', units: 4, note: 'A mistake' }),
  expiringCopy({ units: 4, expiresOn: '2027-02-08', workedDate: '2026-11-08' }),
];

/** The titles and bodies the break subscriber writes, read through a fake store. */
async function breakNotices() {
  const saved: { title: string; body: string }[] = [];
  const subscriber = new BreakEventsSubscriber(
    { subscribe: jest.fn() } as never,
    {
      create: jest.fn(async (row: { title: string; body: string }) => {
        saved.push(row);
        return { id: 'n1', readAt: null, createdAt: new Date(), fromUserId: null, ...row };
      }),
    } as never,
    { emitToUser: jest.fn() } as never,
  );
  const at = new Date('2026-11-09T06:00:00.000Z');
  const asked = (timing: 'LATE' | 'EARLY' | 'OUTSIDE_WINDOW', overrun: boolean, reason?: string) =>
    new BreakApprovalRequestedEvent(
      'r1',
      'u1',
      'Asha Rao',
      ['m1'],
      'MORNING',
      timing,
      12,
      reason ?? null,
      overrun,
      at,
    );
  await subscriber.requested(asked('LATE', false));
  await subscriber.requested(asked('EARLY', false, 'Client call'));
  await subscriber.requested(asked('OUTSIDE_WINDOW', false));
  await subscriber.requested(asked('LATE', true));
  for (const decision of ['APPROVED', 'REJECTED'] as const) {
    await subscriber.decided(
      new BreakDecidedEvent(
        'r1',
        'u1',
        decision,
        'm1',
        'Bala K',
        'MORNING',
        '2026-11-09',
        null,
        at,
      ),
    );
  }
  await subscriber.digest(new ApprovalsDigestEvent('m1', 5, 2, 1, '2026-11-09'));
  return saved;
}

/** The config and the recipients a 4.0 subscriber reads, as one fake. */
const helpers = { get: () => 'Asia/Kolkata', of: async () => ['m1'] };

/** What a subscriber writes for one event, read through a fake bus and a fake store. */
async function writtenBy(
  Subscriber: new (...args: never[]) => { onModuleInit(): void },
  event: unknown,
): Promise<{ title: string; body: string }> {
  let handle: (e: unknown) => Promise<void> = async () => undefined;
  const create = jest.fn(async (row: { title: string; body: string }) => ({
    id: 'n1',
    readAt: null,
    createdAt: new Date(),
    fromUserId: null,
    ...row,
  }));
  new Subscriber(
    {
      subscribe: (_name: string, fn: (e: unknown) => Promise<void>) => {
        handle = fn;
      },
    } as never,
    { create } as never,
    { emitToUser: jest.fn() } as never,
    // 4.0: after the gateway come the config (the timezone) and the oversight recipients
    // (the department's managers, else the organisation admin), in whichever order.
    ...Array<never>(2).fill(helpers as never),
  ).onModuleInit();
  await handle(event);
  return create.mock.calls[0][0];
}

const AGENT_ACTIVATED = { userId: 'u1', userName: 'Asha Rao', managerId: 'm1' };
const SUBSCRIBERS = [
  [
    'C-821',
    ChatMessageSubscriber,
    { toUserId: 'm1', fromUserId: 'u1', fromName: 'Asha Rao', body: 'The report is ready' },
    { title: 'New message from Asha Rao', body: 'The report is ready' },
  ],
  [
    'C-886, C-887',
    DayEndedSubscriber,
    {
      userId: 'u1',
      userName: 'Asha Rao',
      managerId: 'm1',
      endedAt: new Date('2026-11-09T13:00:00.000Z'),
    },
    {
      title: 'Asha Rao ended their working day',
      body:
        'Signed off at 6:30 PM. Activity tracking, screen captures and attendance have stopped ' +
        "for the rest of the day. Today's totals are final.",
    },
  ],
  [
    'C-890, C-891',
    CompanyAssignedSubscriber,
    { userId: 'm1', userRole: Role.MANAGER, companyId: 'c1', companyName: 'RhythmRx' },
    { title: 'New company assigned', body: 'You have been assigned to RhythmRx.' },
  ],
  [
    'C-892',
    MeetingNoteSharedSubscriber,
    { managerId: 'm1', fromUserId: 'u1', fromName: 'Asha Rao', note: 'With the payer team' },
    { title: 'Asha Rao is in a meeting', body: 'With the payer team' },
  ],
] as const;

const WFH_DAY = { mask: 15, units: 4, pendingMask: 0, source: 'REQUEST', capSec: 28800 } as const;
const AT_THE_OFFICE = { biometric: true, openSource: 'BIOMETRIC', dayIsToday: true };
const AT_HOME = { biometric: true, openSource: null, dayIsToday: true };

/** C-719 to C-723: `wfh.startBlocked` and `wfh.label` on the day's view, in every state. */
const WFH_DAYS = [
  [
    'C-719',
    wfhDayView(WFH_DAY as never, { ...AT_HOME, biometric: false }),
    'Your desktop app tracks your day, at home too.',
  ],
  [
    'C-720',
    wfhDayView({ ...WFH_DAY, mask: 0, pendingMask: 15 } as never, AT_HOME),
    'Your work from home today is waiting for approval.',
  ],
  [
    'C-721',
    wfhDayView(WFH_DAY as never, { ...AT_HOME, dayIsToday: false }),
    'Work from home starts on the day itself.',
  ],
  ['C-722', wfhDayView(WFH_DAY as never, AT_THE_OFFICE), 'You are checked in at the office.'],
] as const;

/** Every `.ts` under `dir`, specs left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const SRC = join(__dirname, '..', '..');

/** A word with no sentence in it: an error code. */
const CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Every text under `node`, however it is built: both arms of a ternary, both sides of a plus,
 * a template with each `${...}` read as "x" and the texts inside those read too.
 */
function textsIn(node: ts.Node): string[] {
  if (ts.isStringLiteralLike(node)) return CODE.test(node.text) ? [] : [node.text];
  const found: string[] = [];
  if (ts.isTemplateExpression(node)) {
    found.push(node.head.text + node.templateSpans.map((s) => `x${s.literal.text}`).join(''));
  }
  ts.forEachChild(node, (child) => {
    found.push(...textsIn(child));
  });
  return found;
}

/** What a refusal sends: the arguments of `new SomeError(...)` and `fail(...)`, and `message:`. */
function inlineRefusals(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // A plain Error is for the log, never for a person.
    const refuses =
      (ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /(Error|Exception)$/.test(node.expression.text) &&
        node.expression.text !== 'Error') ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'fail');
    if (refuses) for (const arg of node.arguments ?? []) found.push(...textsIn(arg));
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'message') {
      found.push(...textsIn(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true));
  return found;
}

describe('the rule check itself', () => {
  it.each([
    ['BREAK TIME EXCEEDED!', ['exclamation mark', 'capitals: BREAK']],
    ['You are idle', ['the word "idle"']],
    ['Your break is overdue', ['the word "overdue"']],
    ['You started 20 min late', ['the word "late"']],
    ['Sign-in failed', ['the word "failed"']],
    ['A warning for you', ['the word "warning"']],
    ['Press End Day', ['not sentence case']],
  ])('catches %s', (text, broken) => {
    for (const rule of broken) expect(brokenRules(text)).toContain(rule);
  });

  it.each([
    'RX Vision is on until 6:30 PM.',
    'Take 2 days of CL/SL later.',
    'Your next one is at 4:30 PM.',
  ])('passes %s', (text) => {
    expect(brokenRules(text)).toEqual([]);
  });
});

describe('the scan of the sources itself', () => {
  it('reads a refusal however it is built, and leaves out codes and the log', () => {
    const source = `
      throw new ConflictError(ok ? 'One arm' : 'The other arm', 'SOME_CODE');
      plan.problem = { field: 'when', code: 'SOME_CODE', message: 'From a plan' };
      problem(cond ? { message: 'In an object, one arm' } : { message: \`Other, \${n} days\` });
      new ValidationError('Before a plus ' + name + ' after a plus');
      throw new UnprocessableError(
        p === 'A' ? \`At least \${n}.\` : p === 'B' ? 'At most.' : 'Neither.',
        'CODE',
      );
      return fail('field', 'SOME_CODE', \`\${day} has \${n === 1 ? 'one break' : 'two breaks'} left\`);
      throw new Error('Only for the log');
    `;
    expect(inlineRefusals(source)).toEqual([
      'One arm',
      'The other arm',
      'From a plan',
      'In an object, one arm',
      'Other, x days',
      'Before a plus ',
      ' after a plus',
      'At least x.',
      'At most.',
      'Neither.',
      'field',
      'x has x left',
      'one break',
      'two breaks',
    ]);
  });

  it('holds what it reads to every rule, not only the tone', () => {
    const shouted = 'That day started on time. Tap End Day. NO REASON IS NEEDED.';
    expect(brokenRules(shouted, INLINE_CAPITALS_ALLOWED)).toEqual(
      expect.arrayContaining(['capitals: NO', 'capitals: REASON', 'not sentence case']),
    );
    expect(brokenRules('Give the punch time (YYYY-MM-DD HH:MM).', INLINE_CAPITALS_ALLOWED)).toEqual(
      [],
    );
    // What is allowed in an admin refusal stays shouting everywhere else.
    expect(brokenRules('Pick GENERIC or BIOTIME.')).toContain('capitals: GENERIC');
  });
});

describe('brief 1.5 rules', () => {
  it.each(Object.keys(API_COPY) as (keyof typeof API_COPY)[])('API_COPY.%s', (key) => {
    expect(brokenRules(rendered(API_COPY[key]))).toEqual([]);
  });

  it.each(
    [false, true].flatMap((fileTransfers) =>
      staffGuide(GUIDE_NUMBERS, { fileTransfers }).map(
        (item) => [`${item.n} (file transfers ${fileTransfers})`, item] as const,
      ),
    ),
  )('staff guide, point %s', (_label, item) => {
    expect(brokenRules(`${item.title} ${item.body}`)).toEqual([]);
  });

  it.each(PRESET_KINDS)('reason presets, %s', (kind) => {
    for (const text of DEFAULT_REASON_PRESETS[kind]) expect(brokenRules(text)).toEqual([]);
  });

  it.each(NOTICES.map((n) => [n.title, n] as const))('notice: %s', (_title, notice) => {
    expect(brokenRules(`${notice.title} ${notice.body}`)).toEqual([]);
  });

  it('what the break subscriber writes, and its effect sentences', async () => {
    for (const n of await breakNotices()) expect(brokenRules(`${n.title} ${n.body}`)).toEqual([]);
    for (const mode of ['PLUS', 'MINUS', 'KEPT', 'NONE'] as const) {
      expect(brokenRules(effectSentence({ mode, minutes: 15 }) as string)).toEqual([]);
    }
  });

  it.each(['BREAK', 'MEETING', 'LEAVE', 'WFH', 'COMPOFF'] as const)('push copy, %s', (what) => {
    const push = approvalPushCopy(what);
    expect(brokenRules(`${push.title} ${push.body}`)).toEqual([]);
  });

  it.each(['start', 'end', 'act'] as const)('biometric refusal, %s', (action) => {
    expect(brokenRules(attendanceByBiometric(action).message)).toEqual([]);
  });

  it('the labels added with the meeting status and the payroll pause', () => {
    expect(brokenRules(STATUS_MEETING_LABEL)).toEqual([]);
    expect(brokenRules(PAYROLL_PAUSED_LABEL)).toEqual([]);
  });

  it('a request, as the person reads where it stands', () => {
    for (const label of Object.values(STATUS_LABEL)) expect(brokenRules(label)).toEqual([]);
  });

  it.each(SUBSCRIBERS.map(([id, Subscriber, event]) => [id, Subscriber, event] as const))(
    'what the notice subscribers write: %s',
    async (_id, Subscriber, event) => {
      const notice = await writtenBy(Subscriber, event);
      expect(brokenRules(`${notice.title} ${notice.body}`)).toEqual([]);
    },
  );

  it('C-719 to C-723: why work from home cannot start, in every state', () => {
    for (const [, view] of WFH_DAYS) {
      expect(brokenRules(`${view?.label} ${view?.startBlocked}`)).toEqual([]);
    }
  });

  it('every refusal written inline in the API, read from the sources', () => {
    const found = sources(SRC).flatMap((file) =>
      inlineRefusals(readFileSync(file, 'utf8')).map((text) => ({ where: file, text })),
    );
    expect(found.length).toBeGreaterThan(500);
    const wrong = found.filter(({ text }) => brokenRules(text, INLINE_CAPITALS_ALLOWED).length);
    expect(wrong).toEqual([]);
  });
});

describe('COPY_DECK Part B, as written', () => {
  const T = '1:45 PM';
  const rows: [string, unknown, string][] = [
    // B1
    [
      'C-669',
      new InvalidCredentialsError().message,
      'Check your email and password, then try again.',
    ],
    ['C-670', API_COPY.signInPaused(15), 'Try again in 15 minutes. Sign-in is paused for now.'],
    ['C-670 one', API_COPY.signInPaused(1), 'Try again in 1 minute. Sign-in is paused for now.'],
    [
      'C-671',
      API_COPY.networkSignInPaused(10),
      'Try again in 10 minutes. Sign-in from your network is paused for now.',
    ],
    [
      'C-672, C-675',
      API_COPY.accountOff,
      'Ask the organisation admin to turn your account back on.',
    ],
    ['C-673, C-674, C-676', new UnauthorizedError().message, 'Sign in again to carry on.'],
    ['C-677', API_COPY.unavailable, "RX Vision isn't available right now. Try again in a moment."],
    ['C-678', API_COPY.tryAgain, 'Try again in a moment.'],
    ['C-679', new NotFoundError().message, "We can't find that. Refresh and try again."],
    ['C-680', API_COPY.alreadySaved, "That's already saved."],
    // B2
    [
      'C-684',
      API_COPY.startNote(T, 10),
      "Your shift started at 1:45 PM. Add a short note for your department's managers (10 " +
        'characters or more).',
    ],
    ['C-685', API_COPY.reasonTooLong(500), 'Keep the reason under 500 characters.'],
    ['C-686', API_COPY.noNoteNeeded, 'No note is needed. That day has no Start day.'],
    [
      'C-688',
      API_COPY.noteForManager(10),
      "Add a short note for your department's managers (10 characters or more).",
    ],
    ['C-689', API_COPY.dayNotFound, "We can't find that day. Refresh and try again."],
    ['C-690', API_COPY.profileNotFound, "We can't find your profile. Sign in again."],
    ['C-691', API_COPY.nothingToEnd, 'Start your day first. There is nothing to end yet.'],
    [
      'C-692',
      API_COPY.approvalsToDecide(3, 48),
      'Decide 3 approvals in the portal to end your day. They are past 48 hours.',
    ],
    [
      'C-692 one',
      API_COPY.approvalsToDecide(1, 48),
      'Decide 1 approval in the portal to end your day. It is past 48 hours.',
    ],
    ['C-698', API_COPY.dayNotStarted, 'Tap Start day first. Your day has not started.'],
    ['C-699, C-767', API_COPY.dayEnded, 'Tap Start day to carry on. Your working day has ended.'],
    [
      'C-700',
      monthLockedError('2026-09').message,
      'Ask the organisation admin to unlock September 2026. It is locked for payroll.',
    ],
    // B5
    [
      'C-724',
      API_COPY.breakNotScheduled('lunch break'),
      'No lunch break is scheduled for you today.',
    ],
    [
      'C-725',
      API_COPY.breakAlreadyTaken('lunch break'),
      "You've already taken your lunch break today.",
    ],
    [
      'C-726',
      API_COPY.breakOrder('lunch break', 'morning break'),
      "You've already taken your lunch break, so the morning break is no longer available.",
    ],
    ['C-727', API_COPY.breakOpensAt('lunch break', T), 'Your lunch break opens at 1:45 PM.'],
    [
      'C-728',
      API_COPY.breakWindowClosedSkipped('lunch break', T),
      'The lunch break window closed at 1:45 PM. It counts as skipped.',
    ],
    [
      'C-729',
      API_COPY.breakWasDue('lunch break', T, 10),
      "Your lunch break was due at 1:45 PM. Add a short note for your department's managers " +
        '(10 characters or more).',
    ],
    [
      'C-730',
      API_COPY.breakIsDue('lunch break', T, 10),
      "Your lunch break is due at 1:45 PM. Add a short note for your department's managers " +
        '(10 characters or more).',
    ],
    ['C-731', API_COPY.breaksNextDay, 'Breaks start again with your next working day.'],
    ['C-732', API_COPY.alreadyOnBreak, "Tap Resume work first. You're already on break."],
    [
      'C-733',
      API_COPY.overrunNote(12, 10),
      'Add a short note to count these 12 min (10 characters or more), or leave them out.',
    ],
    [
      'C-736',
      API_COPY.breakHasRecord('lunch break'),
      'Your lunch break already has a record today.',
    ],
    [
      'C-739',
      API_COPY.breakWindowClosed('lunch break', T),
      'The lunch break window closed at 1:45 PM.',
    ],
    ['C-740', API_COPY.onBreak, "Tap Resume work first. You're on break."],
    ['C-742', API_COPY.breakNotFound, "We can't find that break. Refresh and try again."],
    ['C-744', API_COPY.skipHasReason, 'This skip already has a reason.'],
    // B6
    ['C-757', API_COPY.meetingAgenda(300), 'Give the meeting an agenda (1 to 300 characters).'],
    ['C-758', API_COPY.resumeBeforeMeeting, 'Tap Resume work first, then start the meeting.'],
    ['C-759', API_COPY.endMeetingFirst, 'Tap End meeting first, then start the next one.'],
    ['C-760', API_COPY.meetingNotFound, "We can't find that meeting. Refresh and try again."],
    ['C-762', API_COPY.pickMeetingStart, 'Pick when it started.'],
    [
      'C-763',
      API_COPY.meetingInFuture,
      'Pick an earlier start or fewer minutes. That meeting ends after now.',
    ],
    ['C-764', API_COPY.meetingOutsideDay, 'Pick a time between Start day and now.'],
    [
      'C-765',
      API_COPY.meetingOverlapsBreak,
      'Pick another time. That meeting overlaps a break or lunch.',
    ],
    [
      'C-766',
      API_COPY.meetingOverlapsMeeting,
      'Pick another time. That meeting overlaps another meeting.',
    ],
    // B7
    [
      'C-768',
      API_COPY.chatContacts,
      'You can message your own team, their managers and your organisation admin.',
    ],
    ['C-769', API_COPY.noticeNotFound, "We can't find that notice. Refresh and try again."],
    [
      'C-770',
      API_COPY.agentNotOnServer('macOS'),
      "Try again soon. The macOS app isn't on the server yet.",
    ],
    // B8
    ['C-785', API_COPY.pickFirstDay, 'Pick a first day.'],
    ['C-786', API_COPY.pickLastDay, 'Pick a last day.'],
    ['C-788', API_COPY.pickLastDayAfterFirst, 'Pick a last day after the first day.'],
    ['C-798', API_COPY.leaveRequestNotFound, "We can't find that request. Refresh and try again."],
    [
      'C-801',
      API_COPY.leaveStarted,
      'Ask your approver to revoke it if it should not count. This leave has already begun.',
    ],
    // B9
    [
      'C-810',
      meetingDecidedCopy({ approved: false, date: '2026-11-09', deciderName: 'B', note: null })
        .title,
      'Your meeting on 9 Nov was not approved',
    ],
    [
      'C-813',
      dayAutoClosedSelfCopy({ closedAt: T }).title,
      'Your day was closed for you at 1:45 PM',
    ],
    [
      'C-814',
      dayAutoClosedSelfCopy({ closedAt: T }).body,
      'We closed it at your last keyboard or mouse input.',
    ],
    ['C-815', lateStartReasonCopy({ graceMin: 15 }).title, 'Add a note about your start today'],
    [
      'C-816',
      lateStartReasonCopy({ graceMin: 15 }).body,
      "Let your department's managers know why. Updating RX Vision on this computer lets it ask " +
        'you next time. Your day started more than 15 minutes after your shift start.',
    ],
    [
      'C-816 one',
      lateStartReasonCopy({ graceMin: 1 }).body,
      "Let your department's managers know why. Updating RX Vision on this computer lets it ask " +
        'you next time. Your day started more than 1 minute after your shift start.',
    ],
    [
      'C-818',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: 1800, reason: 'x', voided: true }).body,
      'The 30 minutes added to your focus time for 9 Nov have been undone. That day is back to ' +
        'what the app recorded.',
    ],
    [
      'C-818 one',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: 60, reason: 'x', voided: true }).body,
      'The 1 minute added to your focus time for 9 Nov has been undone. That day is back to ' +
        'what the app recorded.',
    ],
    [
      'C-817 one',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: -60, reason: 'x', voided: true }).body,
      'The 1 minute taken off your focus time for 9 Nov has been undone. That day is back to ' +
        'what the app recorded.',
    ],
    [
      'C-820',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: 1800, reason: 'Power cut', voided: false })
        .body,
      'The Super Manager added 30 minutes to your focus time for 9 Nov: Power cut',
    ],
    [
      'C-820 one',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: 60, reason: 'Power cut', voided: false })
        .body,
      'The Super Manager added 1 minute to your focus time for 9 Nov: Power cut',
    ],
    [
      'C-819 one',
      focusAdjustedCopy({ date: '2026-11-09', deltaSec: -60, reason: 'Power cut', voided: false })
        .body,
      'The Super Manager took 1 minute off your focus time for 9 Nov: Power cut',
    ],
    [
      'C-823',
      noCheckoutSelfCopy({ day: 'Mon 9 Nov', at: T }).body,
      'If you left after 1:45 PM, tell the organisation admin so the punch can be added. No ' +
        'check-out was ' +
        'recorded on Mon 9 Nov, so the day was closed at 1:45 PM.',
    ],
    [
      'C-827',
      leaveDecidedCopy({
        request: LEAVE,
        approved: false,
        byName: 'Bala K',
        note: 'Release week',
        availableUnits: 30,
      }).body,
      'CL/SL, 5 days, not approved by Bala K: Release week. The days are back in your balance. ' +
        'You have 7.5 days of CL/SL left.',
    ],
    [
      'C-841',
      wfhDecidedCopy({ request: WFH, approved: false, byName: 'Bala K', note: 'Client visit' })
        .body,
      'Bala K did not approve work from home, 1 day. Note: Client visit.',
    ],
    [
      'C-849',
      wfhAutoEndedCopy({ endedAt: T }).body,
      'We ended your remote day at 1:45 PM, the end of your shift.',
    ],
    [
      'C-851',
      decidedCopy({
        workedDate: '2026-11-08',
        approved: false,
        byName: 'Bala K',
        askedUnits: 4,
        units: 0,
        expiresOn: null,
        note: 'No release that day',
      }).body,
      'Bala K did not approve your comp off claim for Sun 8 Nov. Note: No release that day.',
    ],
    [
      'C-858',
      expiringCopy({ units: 4, expiresOn: '2027-02-08', workedDate: '2026-11-08' }).title,
      'Take your comp off by Mon 8 Feb',
    ],
    [
      'C-859',
      expiringCopy({ units: 4, expiresOn: '2027-02-08', workedDate: '2026-11-08' }).body,
      'Apply for it in RX Vision, Leave. 1 day of comp off for Sun 8 Nov is not taken yet and ' +
        'lapses after Mon 8 Feb.',
    ],
    // B10
    [
      'C-865',
      skipRequestedCopy({ name: 'Asha Rao', kind: 'MORNING', reason: null }).body,
      'Review it in Approvals. No note yet.',
    ],
    [
      'C-870',
      autoSkipRequestedCopy({ name: 'Asha Rao', kind: 'LUNCH', at: T }).title,
      "Asha Rao's lunch break was skipped automatically",
    ],
    [
      'C-879',
      overdueCopy(3, 48).body,
      'Decide them in Approvals. They now show for the organisation admin too.',
    ],
    [
      'C-885',
      dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: T }).body,
      'The day was closed at the last input, 1:45 PM.',
    ],
  ];

  it.each(rows)('%s', (_id, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('C-702 to C-718: the staff guide', () => {
    const items = staffGuide(GUIDE_NUMBERS, { fileTransfers: false });
    expect(items.map((i) => [i.title, i.body])).toEqual([
      [
        'Start your day',
        'Tap Start day when you begin work. Your focus time counts from that moment. Starting ' +
          'more than 15 minutes after your shift starts asks for a short note.',
      ],
      [
        'Breaks and reminders',
        'A small badge on the icon shows 2 minutes before each break. Start your break in the ' +
          'next 5 minutes and nothing more is needed. Starting before or after that asks for a ' +
          "short note for your department's managers.",
      ],
      [
        'Skipping a break',
        'If you cannot take a break, tap Skip this break and add a short note. A break you ' +
          'neither take nor skip before its window closes is skipped for you, and you add a ' +
          'comment before you end the day.',
      ],
      [
        'Resume work',
        'Tap Resume work when you return. If your break runs over, add a short note and you can ' +
          "ask your department's managers to count those minutes.",
      ],
      [
        'Paid time',
        'Your focus time is paid. Your scheduled breaks plus a small buffer of 10 minutes are ' +
          'paid. Break time beyond that is not.',
      ],
      [
        'Meetings',
        'Tap Start meeting when you join one and End meeting when it finishes. Time marked In a ' +
          'meeting needs no approval and always counts as working and focus time. You can also ' +
          "log a meeting that already happened; your department's managers review those.",
      ],
      [
        'Screenshots and activity',
        'While your day is open, RX Vision notes which app is in front, whether the keyboard or ' +
          'mouse is in use, and takes screenshots every few minutes. Nothing is recorded before ' +
          'Start day or after End day.',
      ],
      [
        'End your day',
        'Tap End day when you finish. If it slips your mind, RX Vision ends your day once your ' +
          'shift is over and there has been no keyboard or mouse input for 30 minutes, and ' +
          'records your last input as the end time.',
      ],
      [
        'Approvals, history and your calendar',
        "Your department's managers decide on skipped breaks, extended breaks and logged " +
          'meetings. Their ' +
          'decisions show in your history, and your calendar shows your working days and ' +
          'holidays for the year.',
      ],
    ]);
  });

  it('C-753, C-754, C-756: the presets, the other choices as they were', () => {
    expect(DEFAULT_REASON_PRESETS.SKIP_COMMENT).toEqual([
      'On a client call',
      'In a meeting',
      'Deadline',
      'Busy at the time',
    ]);
    expect(DEFAULT_REASON_PRESETS.BREAK_OVERRUN).toEqual([
      'A call ran over',
      'Queue at the canteen',
      'Helped a colleague',
      'Time ran on',
    ]);
    expect(DEFAULT_REASON_PRESETS.DECISION_NOTE).toEqual([
      'Approved, thanks for the note',
      "Thanks. Let's keep breaks to their times.",
      'Let us talk about this',
    ]);
  });

  it('C-804, C-860, C-861, C-865, C-867: what the break subscriber writes', async () => {
    const [late, early, outside, extended, approved, notApproved, digest] = await breakNotices();
    expect(late.title).toBe('Asha Rao started the morning break 12 min after its time');
    expect(late.body).toBe('Review it in Approvals. No note yet.');
    expect(early.title).toBe('Asha Rao started the morning break 12 min early');
    expect(early.body).toBe('Reason: Client call');
    expect(outside.title).toBe('Asha Rao took a break outside the break windows');
    expect(extended.title).toBe("Asha Rao's morning break was extended");
    expect(approved.title).toBe('Your morning break on 9 Nov was approved');
    expect(notApproved.title).toBe('Your morning break on 9 Nov was not approved');
    expect(digest.body).toBe(
      '5 pending, 2 due within 24 hours, 1 past their time. Review them in Approvals.',
    );
  });

  it('C-803, C-804: a break with no kind has no article', async () => {
    const decided = async (decision: 'APPROVED' | 'REJECTED') => {
      const event = new BreakDecidedEvent(
        'r1',
        'u1',
        decision,
        'm1',
        'Bala K',
        null,
        '2026-11-09',
        null,
        new Date(),
      );
      const saved: { title: string }[] = [];
      await new BreakEventsSubscriber(
        { subscribe: jest.fn() } as never,
        {
          create: jest.fn(async (row: { title: string; body: string }) => {
            saved.push(row);
            return { id: 'n1', readAt: null, createdAt: new Date(), fromUserId: null, ...row };
          }),
        } as never,
        { emitToUser: jest.fn() } as never,
      ).decided(event);
      return saved[0].title;
    };
    expect(await decided('APPROVED')).toBe('Your unscheduled break on 9 Nov was approved');
    expect(await decided('REJECTED')).toBe('Your unscheduled break on 9 Nov was not approved');
  });

  it.each(SUBSCRIBERS)('%s: as written', async (_id, Subscriber, event, words) => {
    expect(await writtenBy(Subscriber, event)).toMatchObject(words);
  });

  it.each(WFH_DAYS)('%s: as written', (_id, view, startBlocked) => {
    expect(view?.startBlocked).toBe(startBlocked);
  });

  it('C-723: a day still waiting', () => {
    expect(WFH_DAYS[1][1]?.label).toBe('Waiting for approval');
  });

  it('C-889: no em dash in the agent activated notice', async () => {
    const notice = await writtenBy(AgentActivatedSubscriber, AGENT_ACTIVATED);
    expect(notice.title).toBe('Asha Rao activated RX Vision');
    expect(notice.body).toBe(
      'Their device is now set up: attendance, activity and screen monitoring are active.',
    );
  });

  it('no old sentence of a changed row is left in the API', () => {
    const old = [
      'Invalid email or password',
      'Too many wrong passwords',
      'Too many failed sign-ins',
      'Your account has been blocked',
      'Missing refresh token',
      'Invalid or expired refresh token',
      'Account is no longer active',
      'Not signed in',
      'Service temporarily unavailable',
      'Resource not found',
      'Resource already exists',
      'there is no late start',
      'Say why you started late',
      'That day could not be found',
      'so there is nothing to end',
      'Press Start Day',
      'Press End Day',
      'Press Back to work',
      'press Skip',
      'locked for payroll. A Super Admin must unlock it before',
      'Breaks and the ring',
      "'Unknown break'",
      'This break is not yours.',
      'Forgot to take it',
      'Lost track of time',
      'Please take breaks on time',
      "'Unknown meeting'",
      'This meeting is not yours.',
      'must be an ISO-8601 instant',
      'Tracking resumes tomorrow',
      'You can only message',
      "'Unknown notification'",
      'The first day must be a real day',
      'The last day must be a real day',
      'The last day is before the first day',
      "'Unknown leave request'",
      'End Day was not pressed',
      'If you left later',
      'was not ended, so it was ended',
      'Comp off lapses on',
      'No reason given',
      'was auto-skipped',
      'Decide them in the portal to end your day',
      "You're starting",
      'Say why you were back',
      'Say why you are skipping',
      "You're already on a break",
      'End it before',
      "You're already in a meeting",
      'Resume work before starting a meeting',
      'That meeting ends after now. Log only',
      'not inside today',
      'agent is not available on the server',
      'This leave has already begun. Ask',
      'rejected by',
      'rejected your comp off',
      'rejected ${wfhWhat',
      'You started ${',
      'That is not one of the avatars',
      'You can pick only',
      'Only a Super Admin can set gender',
      'Only a Super Admin can filter by gender',
      'integrationOn must be on or off',
    ];
    const left = sources(SRC).flatMap((file) => {
      // The retired default lists are named once, so that a stored copy of one reads as not saved.
      const text = readFileSync(file, 'utf8').replace(/const RETIRED_DEFAULTS[\s\S]*?\n};/, '');
      return old.filter((s) => text.includes(s)).map((s) => `${file}: ${s}`);
    });
    expect(left).toEqual([]);
  });
});

describe('API copy added after the deck was written (C-905 on)', () => {
  it.each([
    ['C-905', API_COPY.resumeBeforeMeeting, 'Tap Resume work first, then start the meeting.'],
    ['C-906', API_COPY.endMeetingFirst, 'Tap End meeting first, then start the next one.'],
    ['C-907', API_COPY.avatarUnknown, 'Pick one of the avatars.'],
    [
      'C-908',
      API_COPY.avatarProfileNotSetUp,
      'Ask the organisation admin to set up your profile. Then you can choose your avatar.',
    ],
    ['C-909', API_COPY.avatarOtherLibrary, 'You can pick from your own avatars.'],
    ['C-911', API_COPY.personNotFound, "We can't find that person. Refresh and try again."],
    ['C-912', API_COPY.avatarNotFound, "We can't find that avatar. Refresh and try again."],
    ['C-913', API_COPY.genderSetByAdmin, 'Ask the organisation admin to set gender.'],
    ['C-914', API_COPY.genderFilterByAdmin, 'Ask the organisation admin to filter by gender.'],
    ['4.0', API_COPY.avatarResetByAdmin, 'Ask the organisation admin to reset this avatar.'],
    ['C-915', API_COPY.pickOnOrOff, 'Pick on or off.'],
    ['C-923', API_COPY.meetingNeedsNoApproval, 'This meeting needs no approval.'],
    ['C-937', API_COPY.rateLimited, 'Try again in a minute.'],
  ])('%s', (_id, actual, expected) => {
    expect(actual).toBe(expected);
  });

  describe('C-938 to C-942: GET /approvals/me, as the person reads their own items', () => {
    const ist = (hm: string) => new Date(`2026-11-09T${hm}:00.000+05:30`);
    const lunch: BreakTextInput = {
      kind: 'LUNCH',
      presenceType: 'LUNCH',
      minutesOff: 20,
      startedAt: ist('13:20'),
      endedAt: ist('13:50'),
      scheduledStart: ist('13:00'),
      durationMin: 30,
      windowOpen: ist('12:30'),
      windowClose: ist('14:00'),
      overrunSec: 900,
    };
    const CATEGORIES = [
      'BREAK_LATE',
      'BREAK_EARLY',
      'BREAK_OVERRUN',
      'BREAK_OUTSIDE',
      'BREAK_UNSCHEDULED',
      'BREAK_SKIP',
      'BREAK_AUTO_SKIP',
    ] as const;

    it.each(CATEGORIES)('%s follows the rules, title and detail', (category) => {
      const now = ist('15:00');
      const line = `${ownBreakTitle(category, lunch)} ${breakDetail(category, lunch, 'Asia/Kolkata', now, true)}`;
      expect(brokenRules(line)).toEqual([]);
      expect(line).not.toMatch(/\bauto-skipped\b/i);
      // No 24 hour clock: every time carries AM or PM.
      expect(line).not.toMatch(/\b\d{1,2}:\d{2}\b(?! [AP]M)/);
    });

    it('a meeting, on the 12 hour clock', () => {
      const ran = {
        startedAt: ist('10:00'),
        endedAt: ist('13:45'),
        durationSec: 13500,
        participants: 0,
      };
      expect(meetingDetail(ran, 'Asia/Kolkata')).toBe('10:00 AM to 1:45 PM · 225 min');
    });
  });

  it('C-943, C-944: a request that was not approved', () => {
    expect(STATUS_LABEL.REJECTED).toBe('Not approved');
    expect(`This request ${alreadyStatus('REJECTED')}.`).toBe('This request was not approved.');
    expect(`This claim ${alreadyStatus('REJECTED')}.`).toBe('This claim was not approved.');
  });

  it('a close during a status meeting has its own calm body, for the person and the manager', () => {
    const self = dayAutoClosedSelfCopy({ closedAt: '8:30 PM', meeting: 'RUNNING' });
    expect(self.title).toBe('Your day was closed for you at 8:30 PM');
    expect(self.body).toBe(
      "Tap Start day if you're still working. Your meeting time up to then counts.",
    );
    expect(self.body).not.toMatch(/keyboard|mouse/);
    const manager = dayAutoClosedManagerCopy({
      name: 'Asha Rao',
      closedAt: '8:30 PM',
      meeting: 'RUNNING',
    });
    expect(manager.body).toBe(
      'They were in a meeting. The day was closed at 8:30 PM, and that time counts.',
    );
    expect(manager.body).not.toMatch(/last input/);
  });

  it('a close at the end of a status meeting says that, not the keyboard', () => {
    expect(dayAutoClosedSelfCopy({ closedAt: '5:30 PM', meeting: 'ENDED' }).body).toBe(
      'We closed it at the end of your meeting.',
    );
    expect(
      dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: '5:30 PM', meeting: 'ENDED' }).body,
    ).toBe('The day was closed at the end of their meeting, 5:30 PM.');
  });
});
