// RX Vision 3.1 end to end (SPEC 1 to 3) with 3.1 and older agents: the working day
// (Start Day, End Day, resume), skips and comments, the End Day gates, overruns,
// meetings, the unified approvals and the 48-hour rule, the month lock, settings,
// activity visibility, Team today and reports.
// Needs a freshly reset and seeded database and a freshly started API: see README.md.
// Writes to the local database (through @prisma/client) only for what no API can do:
// a skip left from yesterday, an item made overdue or escalated, a day in August.
import ExcelJS from 'exceljs';
import { AGENT_30_UA, AGENT_31_UA, Client, check, expectStatus, hm, summary, todayKey } from '../lib.mjs';
import { openDb, wallToUtc } from '../db.mjs';

const MIN = 60_000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const plus = (d, minutes) => new Date(d.getTime() + minutes * MIN);
const iso = (d) => d.toISOString();
const secs = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 1000;
const today = todayKey();
const yesterday = todayKey(-1);
const month = today.slice(0, 7);
const RUN = Date.now().toString(36);
const PASSWORD = 'Rx-Vision-31!';

// The shifts here are built around now and must stay inside one calendar day.
{
  const [h, m] = hm(new Date()).split(':').map(Number);
  const minute = h * 60 + m;
  if (minute < 125 || minute > 1439 - 185) {
    console.error('Run this suite between 02:05 and 20:54 business time: its shifts are built around now.');
    process.exit(2);
  }
}

const db = await openDb();

/** A client that waits out the per-person rate limit instead of failing. */
class Actor extends Client {
  async req(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const r = await super.req(method, path, body);
      if (r.status !== 429 || attempt >= 2) return r;
      const wait = Math.min(Number(r.headers?.['retry-after'] ?? r.headers?.['x-ratelimit-reset'] ?? 30), 60) + 1;
      console.log(`  ..   ${this.name} is rate limited, waiting ${wait} s`);
      await sleep(wait * 1000);
    }
  }
}

const data = (r) => r.body?.data;
function expectError(label, r, status, code) {
  check(`${label} [${status} ${code}]`, r.status === status && r.body?.error?.code === code, {
    got: r.status,
    body: r.body,
  });
  return r;
}
const types = (list) => new Set((Array.isArray(list) ? list : []).map((n) => n.type));

// ---------------------------------------------------------------------------------------
console.log('\n# People');
const sa = await new Actor('superadmin').login('admin@timechamp.test', 'admin123');
const mgr = await new Actor('manager').login('manager@timechamp.test', 'manager123');
const staffWeb = await new Actor('staff-portal').login('user@timechamp.test', 'user123');
const staff = await new Actor('staff-3.1', AGENT_31_UA).login('user@timechamp.test', 'user123');

async function addPerson(first, last, role, managerId, department) {
  const email = `${first.toLowerCase()}.${RUN}@timechamp.test`;
  const r = await sa.post('/users', { firstName: first, lastName: last, email, password: PASSWORD, role, department, managerId });
  const created = data(r)?.created?.[0];
  check(`SA adds ${first} ${last} (${role})`, r.status === 201 && !!created?.id, r.body);
  return { id: created?.id, email };
}
const anitaP = await addPerson('Anita', 'Desai', 'USER', mgr.user.id, 'Billing');
const raviP = await addPerson('Ravi', 'Shankar', 'USER', mgr.user.id, 'Coding');
const farhanP = await addPerson('Farhan', 'Qureshi', 'USER', mgr.user.id, 'AR Calling');
const snehaP = await addPerson('Sneha', 'Pillai', 'USER', mgr.user.id, 'QA');
const nehaP = await addPerson('Neha', 'Joshi', 'USER', sa.user.id, 'Billing');
const kiranP = await addPerson('Kiran', 'Rao', 'MANAGER', sa.user.id, 'Coding');

const anita = await new Actor('anita-3.1', AGENT_31_UA).login(anitaP.email, PASSWORD);
const anitaOld = await new Actor('anita-3.0', AGENT_30_UA).login(anitaP.email, PASSWORD);
const ravi = await new Actor('ravi-3.0', AGENT_30_UA).login(raviP.email, PASSWORD);
const farhan = await new Actor('farhan-3.1', AGENT_31_UA).login(farhanP.email, PASSWORD);
const sneha = await new Actor('sneha-3.1', AGENT_31_UA).login(snehaP.email, PASSWORD);
const neha = await new Actor('neha-3.1', AGENT_31_UA).login(nehaP.email, PASSWORD);
const kiran = await new Actor('kiran').login(kiranP.email, PASSWORD);
const mgrAgent = await new Actor('manager-3.1', AGENT_31_UA).login('manager@timechamp.test', 'manager123');
const saAgent = await new Actor('superadmin-3.1', AGENT_31_UA).login('admin@timechamp.test', 'admin123');
const team = [staff.user.id, anitaP.id, raviP.id, farhanP.id, snehaP.id];

/** A shift around `base`: hours base-120 to base+180, breaks at base+at minutes. */
async function makeShift(label, base, breaks, rules = {}) {
  const def = {
    name: `V31 ${label} ${RUN}`,
    start: hm(plus(base, -120)),
    end: hm(plus(base, 180)),
    workDays: [1, 2, 3, 4, 5, 6, 7],
    ringLeadMin: 1,
    ringDurationMin: 5,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: true,
    overrunGraceMin: 3,
    ...rules,
    breaks: breaks.map((b) => ({
      kind: b.kind,
      enabled: true,
      startTime: hm(plus(base, b.at)),
      durationMin: b.durationMin,
      windowBeforeMin: b.before,
      windowAfterMin: b.after,
    })),
  };
  const r = await sa.post('/shifts', def);
  check(`SA creates the "${label}" shift`, r.status === 201 && !!data(r)?.id, r.body);
  return data(r);
}
async function assign(by, userIds, shift, label) {
  const r = await by.put('/shift-assignments/people', { userIds, shiftId: shift.id, effectiveFrom: today });
  check(`${label} on the "${shift.name.split(' ')[1]}" shift`, r.status === 200 && data(r)?.assigned?.length === userIds.length, r.body);
}

// ---------------------------------------------------------------------------------------
console.log('\n# Settings (Super Admin)');
let r = expectStatus('staff reads the settings', await staffWeb.get('/settings'), 200);
let d = data(r);
check(
  'defaults: 48 h, block on, 80/40, grace 10, quiet 20 min x4, auto-close 240',
  d?.approvalSlaHours === 48 &&
    d?.blockManagerEndDayWhenOverdue === true &&
    d?.fullDayPct === 80 &&
    d?.halfDayPct === 40 &&
    d?.lateStartGraceMin === 10 &&
    d?.quietHourActiveMin === 20 &&
    d?.quietHoursFlag === 4 &&
    d?.autoCloseAfterShiftEndMin === 240,
  d,
);
expectStatus('a Manager cannot change them', await mgr.patch('/settings', { quietHoursFlag: 5 }), 403);
for (const [patch, field] of [
  [{ approvalSlaHours: 6 }, 'approvalSlaHours'],
  [{ approvalSlaHours: 169 }, 'approvalSlaHours'],
  [{ halfDayPct: 85 }, 'halfDayPct'],
  [{ fullDayPct: 101 }, 'fullDayPct'],
  [{ quietHourActiveMin: 'lots' }, 'quietHourActiveMin'],
  [{ blockManagerEndDayWhenOverdue: 'yes' }, 'blockManagerEndDayWhenOverdue'],
  [{ autoCloseAfterShiftEndMin: 20 }, 'autoCloseAfterShiftEndMin'],
]) {
  r = await sa.patch('/settings', patch);
  check(
    `out of range ${JSON.stringify(patch)} [400 VALIDATION_ERROR, field ${field}]`,
    r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR' && r.body?.error?.details?.field === field,
    r.body,
  );
}
r = expectStatus('a valid subset saves', await sa.patch('/settings', { quietHoursFlag: 5, lateStartGraceMin: 15 }), 200);
check('and the full view comes back', data(r)?.quietHoursFlag === 5 && data(r)?.lateStartGraceMin === 15 && data(r)?.fullDayPct === 80, data(r));
r = expectStatus('put the defaults back', await sa.patch('/settings', { quietHoursFlag: 4, lateStartGraceMin: 10 }), 200);

// ---------------------------------------------------------------------------------------
console.log('\n# Shifts for the day');
const T1 = new Date();
// Morning opens soon (owed only by sessions running at T1+6), lunch cannot be skipped, evening later.
const skipShift = await makeShift('Skip', T1, [
  { kind: 'MORNING', at: 6, durationMin: 15, before: 30, after: 40 },
  { kind: 'LUNCH', at: 70, durationMin: 30, before: 20, after: 30 },
  { kind: 'EVENING', at: 150, durationMin: 15, before: 30, after: 30 },
]);
await assign(mgr, [staff.user.id], skipShift, 'manager puts staff');
await assign(sa, [nehaP.id, sa.user.id], skipShift, 'SA puts Neha and self');
r = expectStatus('staff break day', await staff.get('/breaks/me/today'), 200);
d = data(r);
check(
  'slots say which breaks can be skipped (lunch cannot)',
  d?.breaks?.map((b) => `${b.kind}:${b.allowSkip}`).join(',') === 'MORNING:true,LUNCH:false,EVENING:true',
  d?.breaks,
);
check('the day carries reasonMinChars and no skips waiting', d?.reasonMinChars === 10 && d?.skipsNeedingComment?.length === 0, d);

// ---------------------------------------------------------------------------------------
console.log('\n# Before Start Day (3.1 agent)');
r = expectStatus('workday view', await staff.get('/workday/me/today'), 200);
d = data(r);
check('NOT_STARTED, no sessions, no focus', d?.state === 'NOT_STARTED' && d.sessions.length === 0 && d.focus.focusSec === 0 && d.focus.running === false, d);
check('shift, expected 4 h (5 h minus 60 min of breaks), settings, timezone', d?.shift?.id === skipShift.id && d.expectedSec === 14400 && d.settings.approvalSlaHours === 48 && d.settings.reasonMinChars === 10 && !!d.timezone, d);
check('portal link is an http(s) address or null', d?.portalUrl === null || /^https?:\/\//.test(d?.portalUrl), d?.portalUrl);
r = expectStatus('own presence', await staff.get('/presence/me/current'), 200);
check('presence NOT_STARTED', data(r)?.status === 'NOT_STARTED', data(r));
r = expectStatus('manager team today', await mgr.get('/team/today'), 200);
d = data(r);
check('everyone in the team is NOT_STARTED', d?.rows?.length === 5 && d.rows.every((x) => x.status === 'NOT_STARTED') && d.totals.notStarted === 5, d?.totals);
check('rows carry 24 hours of activity', d?.rows?.every((x) => x.hourly.length === 24), d?.rows?.[0]?.hourly?.length);
r = expectStatus('manager live board', await mgr.get('/presence/team/live'), 200);
check('live board says NOT_STARTED', JSON.stringify(r.body).includes('NOT_STARTED'), r.body);
r = expectStatus('3.1 activity report without a day', await staff.post('/activity/report', { app: 'Excel', idle: false }), 200);
check('not captured (shouldCapture false)', data(r)?.shouldCapture === false, data(r));
r = await staff.get('/workday/me/today');
check('a report does not start a 3.1 day', data(r)?.state === 'NOT_STARTED', data(r)?.state);
expectError('skip before Start Day', await staff.post('/breaks/skip', { kind: 'MORNING', reason: 'Client call at eleven' }), 409, 'DAY_NOT_STARTED');
expectError('meeting before Start Day', await staff.post('/meetings/start', { agenda: 'Standup', participants: [] }), 409, 'DAY_NOT_STARTED');
expectError('log a meeting before Start Day', await staff.post('/meetings/past', { startedAt: iso(plus(new Date(), -30)), durationMin: 10, agenda: 'Standup', participants: [] }), 409, 'DAY_NOT_STARTED');
expectError('End Day before Start Day', await staff.post('/activity/end-day', {}), 409, 'DAY_NOT_STARTED');

// ---------------------------------------------------------------------------------------
console.log('\n# Start Day, End Day and resume (3.1 agent)');
const askedStart = plus(new Date(), -9);
r = expectStatus('Start Day dated 9 minutes back', await staff.post('/activity/start-day', { startedAt: iso(askedStart) }), 200);
d = data(r);
check('accepted as asked, not a resume', d?.ok === true && d.resumed === false && d.date === today && Math.abs(secs(askedStart, d.workday.startedAt)) < 1, d);
check('OPEN and running', d?.workday?.state === 'OPEN' && d.workday.focus.running === true, d?.workday);
check('a late start against the shift', (d?.workday?.lateStart?.minutes ?? 0) > 100, d?.workday?.lateStart);
const S = new Date(d.workday.startedAt);
r = expectStatus('Start Day again', await staff.post('/activity/start-day', {}), 200);
check('idempotent: same session, not a resume', data(r)?.resumed === false && data(r)?.workday?.sessions?.length === 1 && data(r)?.workday?.startedAt === iso(S), data(r));
r = expectStatus('report while the day is open', await staff.post('/activity/report', { app: 'Excel', idle: false }), 200);
check('captured', data(r)?.shouldCapture === true, data(r));

r = await staff.post('/meetings/past', { startedAt: iso(plus(new Date(), -2)), durationMin: 5, agenda: 'Future call', participants: [] });
expectError('log a meeting that ends after now', r, 422, 'MEETING_IN_FUTURE');
r = await staff.post('/meetings/past', { startedAt: iso(plus(S, -10)), durationMin: 5, agenda: 'Before work', participants: [] });
expectError('log a meeting before Start Day', r, 422, 'MEETING_OUTSIDE_DAY');
expectStatus('a meeting under 5 minutes', await staff.post('/meetings/past', { startedAt: iso(plus(S, 1)), durationMin: 4, agenda: 'Tiny', participants: [] }), 400);
expectStatus('a meeting over 8 hours', await staff.post('/meetings/past', { startedAt: iso(plus(S, 1)), durationMin: 481, agenda: 'Huge', participants: [] }), 400);
expectStatus('a meeting with no agenda', await staff.post('/meetings/past', { startedAt: iso(plus(S, 1)), durationMin: 5, participants: [] }), 400);
r = expectStatus('log an earlier meeting', await staff.post('/meetings/past', { startedAt: iso(plus(S, 1)), durationMin: 5, agenda: 'Client sync', participants: [{ name: 'Asha (client)' }] }), 200);
const P1 = data(r)?.meeting;
check('PAST, pending, 300 s', P1?.mode === 'PAST' && P1.approvalStatus === 'PENDING' && P1.durationSec === 300 && !!P1.dueAt, P1);
r = await staff.post('/meetings/past', { startedAt: iso(plus(S, 2)), durationMin: 5, agenda: 'Overlap', participants: [] });
expectError('log one overlapping it', r, 422, 'MEETING_OVERLAPS_MEETING');
check('the overlap names the other meeting', r.body?.error?.details?.with?.kind === 'MEETING' && r.body.error.details.with.startedAt === P1?.startedAt, r.body?.error);

r = expectStatus('a plain lunch from the portal buttons', await staffWeb.post('/presence/start', { type: 'LUNCH' }), 200);
expectError('skip while on lunch', await staff.post('/breaks/skip', { kind: 'MORNING', reason: 'Client call at eleven' }), 409, 'ALREADY_ON_BREAK');
r = await staff.post('/meetings/past', { startedAt: iso(plus(new Date(), -5)), durationMin: 5, agenda: 'During lunch', participants: [] });
expectError('log a meeting over the lunch', r, 422, 'MEETING_OVERLAPS_BREAK');
check('the overlap names the lunch', r.body?.error?.details?.with?.kind === 'LUNCH', r.body?.error);
await sleep(1500);
expectStatus('lunch ends', await staffWeb.post('/presence/end', {}), 200);

r = expectStatus('End Day', await staff.post('/activity/end-day', {}), 200);
d = data(r);
check('ENDED with the end time', d?.workday?.state === 'ENDED' && d.endedAt === d.workday.endedAt && d.workday.autoClosed === false, d?.workday);
check('the workday is the day just ended, with its focus', d?.workday?.date === d?.date && d.workday.focus.focusSec > 0 && d.workday.lastEnded === null, { date: d?.date, workday: d?.workday?.date, focus: d?.workday?.focus });
const firstEnd = d?.endedAt;
r = expectStatus('End Day again', await staff.post('/activity/end-day', {}), 200);
check('idempotent: same end', data(r)?.endedAt === firstEnd, data(r));
r = await staff.post('/activity/report', { app: 'Excel', idle: false });
check('3.1 report after End Day is not captured', data(r)?.shouldCapture === false, data(r));
expectError('skip after End Day', await staff.post('/breaks/skip', { kind: 'MORNING', reason: 'Client call at eleven' }), 409, 'DAY_ENDED');
expectError('break after End Day', await staff.post('/breaks/start', { kind: 'MORNING', reason: 'Client call at eleven' }), 409, 'DAY_ENDED');
expectError('meeting after End Day', await staff.post('/meetings/start', { agenda: 'Late call', participants: [] }), 409, 'DAY_ENDED');
r = await staff.get('/presence/me/current');
check('presence DAY_ENDED', data(r)?.status === 'DAY_ENDED', data(r));
await sleep(2500);
r = expectStatus('Start Day again (resume)', await staff.post('/activity/start-day', {}), 200);
d = data(r);
check('resumed: a second session', d?.resumed === true && d.workday.state === 'OPEN' && d.workday.sessions.length === 2, d?.workday?.sessions);
{
  const w = d?.workday;
  const [s1, s2] = w?.sessions ?? [];
  const expected = s1 && s2 ? secs(s1.startedAt, s1.endedAt) + secs(s2.startedAt, w.serverNow) : -1;
  check('focus spans both sessions, not the gap', Math.abs(w.focus.spanSec - expected) <= 2 && w.focus.spanSec < secs(s1.startedAt, w.serverNow) - 1, { focus: w?.focus, expected });
  check('focus = span minus the lunch', w.focus.focusSec === w.focus.spanSec - w.focus.breakSec && w.focus.breakSec >= 1, w?.focus);
}

// ---------------------------------------------------------------------------------------
console.log('\n# Skip a break');
expectError('skip with no reason', await staff.post('/breaks/skip', { kind: 'MORNING' }), 422, 'REASON_REQUIRED');
r = await staff.post('/breaks/skip', { kind: 'MORNING', reason: 'too short' });
check('too-short reason [422 REASON_REQUIRED, minChars 10]', r.status === 422 && r.body?.error?.details?.minChars === 10, r.body);
expectStatus('unknown kind', await staff.post('/breaks/skip', { kind: 'BRUNCH', reason: 'Client call at eleven' }), 400);
r = expectStatus('skip the morning', await staff.post('/breaks/skip', { kind: 'MORNING', reason: '  Client   escalation call ' }), 200);
const staffSkip = data(r)?.record;
check('SKIPPED, pending, routed to the manager, no presence', staffSkip?.outcome === 'SKIPPED' && staffSkip.approvalStatus === 'PENDING' && staffSkip.approverRole === 'MANAGER' && staffSkip.reason === 'Client escalation call' && staffSkip.needsComment === false && !!staffSkip.dueAt, staffSkip);
check('due 48 hours after the skip', Math.abs(secs(staffSkip?.startedAt, staffSkip?.dueAt) - 48 * 3600) < 5, staffSkip);
expectError('skip it twice', await staff.post('/breaks/skip', { kind: 'MORNING', reason: 'Client escalation call' }), 409, 'BREAK_ALREADY_TAKEN');
expectError('skip lunch', await staff.post('/breaks/skip', { kind: 'LUNCH', reason: 'Client escalation call' }), 409, 'SKIP_NOT_ALLOWED');
r = expectError('skip the evening early', await staff.post('/breaks/skip', { kind: 'EVENING', reason: 'Client escalation call' }), 409, 'BREAK_NOT_OPEN');
check('with the opening time', !!r.body?.error?.details?.opensAt, r.body?.error);
r = expectStatus('the day view shows the skip in its slot', await staff.get('/breaks/me/today'), 200);
check('morning slot holds the SKIPPED record', data(r)?.breaks?.[0]?.record?.id === staffSkip?.id && data(r).breaks[0].record.outcome === 'SKIPPED', data(r)?.breaks?.[0]);
r = expectStatus('workday after the skip', await staff.get('/workday/me/today'), 200);
check('pending: the skip may cost 15 min, the logged meeting 5 (pendingMinusSec)', data(r)?.focus?.pendingMinusSec === 900 + 300, data(r)?.focus);
r = expectStatus('Super Admin starts the day', await saAgent.post('/activity/start-day', {}), 200);
r = expectStatus('Super Admin skips with no reason', await saAgent.post('/breaks/skip', { kind: 'MORNING' }), 200);
check('no approval for a Super Admin', data(r)?.record?.approvalStatus === 'NOT_REQUIRED' && data(r)?.record?.reason === null, data(r)?.record);
expectStatus('Neha (reports to the Super Admin) starts the day', await neha.post('/activity/start-day', {}), 200);
r = expectStatus('Neha skips the morning', await neha.post('/breaks/skip', { kind: 'MORNING', reason: 'Payment run cannot wait' }), 200);
const nehaSkip = data(r)?.record;
check('routed to her Super Admin', nehaSkip?.approvalStatus === 'PENDING' && nehaSkip.approverRole === 'SUPER_ADMIN', nehaSkip);

console.log('\n# Comment rules (wrong targets)');
expectError('comment on a skip that has a reason', await staff.post(`/breaks/${staffSkip?.id}/comment`, { comment: 'Adding more detail here' }), 409, 'COMMENT_NOT_NEEDED');
expectStatus('comment on an unknown break', await staff.post('/breaks/00000000-0000-4000-8000-00000000abcd/comment', { comment: 'Adding more detail here' }), 404);
expectStatus('comment on a malformed id', await staff.post('/breaks/not-an-id/comment', { comment: 'Adding more detail here' }), 400);
expectStatus('comment with no text', await staff.post(`/breaks/${staffSkip?.id}/comment`, {}), 400);

// ---------------------------------------------------------------------------------------
console.log('\n# Live meetings');
r = await staff.post('/meetings/start', { agenda: '   ', participants: [] });
check('blank agenda [400, field agenda]', r.status === 400 && r.body?.error?.details?.field === 'agenda', r.body);
const crowd = Array.from({ length: 31 }, (_, i) => ({ name: `Person ${i + 1}` }));
expectStatus('31 participants', await staff.post('/meetings/start', { agenda: 'Town hall', participants: crowd }), 400);
r = expectStatus('start a quick meeting', await staff.post('/meetings/start', { agenda: 'Quick sync', participants: [{ name: 'Asha' }] }), 200);
const quick = data(r)?.meeting;
check('LIVE, running, presence MEETING', quick?.mode === 'LIVE' && quick.inProgress === true && data(r)?.presence?.status === 'MEETING', data(r));
expectError('a second meeting at once', await staff.post('/meetings/start', { agenda: 'Another', participants: [] }), 409, 'MEETING_IN_PROGRESS');
r = expectStatus('end it within a minute', await staff.post(`/meetings/${quick?.id}/end`, {}), 200);
check('discarded (under 60 s)', data(r)?.discarded === true && data(r)?.meeting === null, data(r));
r = expectStatus('end it again', await staff.post(`/meetings/${quick?.id}/end`, {}), 200);
check('still discarded (idempotent)', data(r)?.discarded === true && data(r)?.meeting === null, data(r));
r = expectStatus('my meetings today', await staff.get('/meetings/me/today'), 200);
check('only the logged one remains', data(r)?.items?.length === 1 && data(r).items[0].id === P1?.id, data(r)?.items);
r = expectStatus('participants picker', await staff.get('/meetings/participants?q=Maya'), 200);
check('finds the manager by name', data(r)?.items?.some((p) => p.id === mgr.user.id), data(r)?.items);
r = expectStatus('start the review meeting', await staff.post('/meetings/start', {
  agenda: 'Sprint review',
  participants: [{ id: mgr.user.id, name: 'Maya Reddy' }, { id: '00000000-0000-4000-8000-000000000999', name: 'Guest' }, { name: ' ' }],
}), 200);
const review = data(r)?.meeting;
check('participants: known id kept, unknown id dropped, blank removed', JSON.stringify(review?.participants) === JSON.stringify([{ id: mgr.user.id, name: 'Maya Reddy' }, { name: 'Guest' }]), review?.participants);
r = expectStatus('manager sees it in Approvals', await mgr.get('/approvals?type=MEETING'), 200);
let item = data(r)?.items?.find((i) => i.id === review?.id);
check('MEETING_LIVE, running, not decidable yet', item?.category === 'MEETING_LIVE' && item.inProgress === true && item.canDecide === false && item.status === 'PENDING', item);
expectError('approve a running meeting', await mgr.post(`/approvals/meeting/${review?.id}/approve`, {}), 409, 'MEETING_IN_PROGRESS');

// ---------------------------------------------------------------------------------------
console.log('\n# Breaks that run over (shifts with no grace)');
const T3 = new Date();
const onTimeShift = await makeShift('Overrun', T3, [
  { kind: 'MORNING', at: -1, durationMin: 1, before: 5, after: 30 },
  { kind: 'LUNCH', at: 60, durationMin: 30, before: 20, after: 30 },
  { kind: 'EVENING', at: 150, durationMin: 15, before: 30, after: 20 },
], { overrunGraceMin: 0 });
const lateShift = await makeShift('Late', T3, [
  { kind: 'MORNING', at: -10, durationMin: 1, before: 15, after: 30 },
  { kind: 'LUNCH', at: 60, durationMin: 30, before: 20, after: 30 },
  { kind: 'EVENING', at: 150, durationMin: 15, before: 30, after: 20 },
], { overrunGraceMin: 0 });
const legacyShift = await makeShift('Legacy', T3, [
  { kind: 'MORNING', at: -80, durationMin: 15, before: 30, after: 30 },
  { kind: 'LUNCH', at: -1, durationMin: 1, before: 5, after: 30 },
  { kind: 'EVENING', at: 60, durationMin: 15, before: 15, after: 30 },
], { overrunGraceMin: 0 });
await assign(mgr, [farhanP.id], onTimeShift, 'manager puts Farhan');
await assign(sa, [mgr.user.id], onTimeShift, 'SA puts the manager');
await assign(mgr, [snehaP.id], lateShift, 'manager puts Sneha');
await assign(mgr, [raviP.id], legacyShift, 'manager puts Ravi');

console.log('\n# An older agent (3.0)');
r = await ravi.get('/workday/me/today');
check('Ravi has not started', data(r)?.state === 'NOT_STARTED', data(r)?.state);
r = expectStatus('an idle sample', await ravi.post('/activity/report', { app: 'Outlook', idle: true }), 200);
r = await ravi.get('/workday/me/today');
check('an idle sample opens no day', data(r)?.state === 'NOT_STARTED', data(r)?.state);
r = expectStatus('an active sample', await ravi.post('/activity/report', { app: 'Outlook', idle: false }), 200);
check('captured as in 3.0', data(r)?.shouldCapture === true, data(r));
r = await ravi.get('/workday/me/today');
check('the first active sample opened the day', data(r)?.state === 'OPEN' && data(r)?.sessions?.length === 1, data(r));
r = expectStatus('Ravi starts lunch on time', await ravi.post('/breaks/start', { kind: 'LUNCH' }), 200);
const raviLunch = data(r)?.record;
check('ON_TIME lunch, no approval', raviLunch?.timing === 'ON_TIME' && raviLunch.approvalStatus === 'NOT_REQUIRED', raviLunch);
expectError('skip the morning after lunch', await ravi.post('/breaks/skip', { kind: 'MORNING', reason: 'Was with a client' }), 409, 'BREAK_ORDER');
r = expectStatus('Kiran (portal) uses the plain meeting button', await kiran.post('/presence/start', { type: 'MEETING', note: 'Vendor call' }), 200);
r = await kiran.get('/meetings/me/today');
check('which makes no meeting record (no approval)', data(r)?.items?.length === 0, data(r));
expectStatus('Kiran ends it', await kiran.post('/presence/end', {}), 200);
r = expectStatus('Kiran ends a day never started (older client)', await kiran.post('/activity/end-day', {}), 200);
r = await kiran.get('/presence/me/current');
check('marked ended as in 3.0', data(r)?.status === 'DAY_ENDED', data(r));

console.log('\n# Start the breaks');
const askedFarhan = plus(new Date(), -30);
r = expectStatus('Farhan starts the day dated 30 min back', await farhan.post('/activity/start-day', { startedAt: iso(askedFarhan) }), 200);
check('too far back: the server uses now', Math.abs(secs(data(r)?.workday?.startedAt, data(r)?.workday?.serverNow)) < 5, data(r)?.workday);
r = expectStatus('Farhan starts the morning on time', await farhan.post('/breaks/start', { kind: 'MORNING' }), 200);
check('ON_TIME, no approval', data(r)?.record?.timing === 'ON_TIME' && data(r)?.record?.approvalStatus === 'NOT_REQUIRED', data(r)?.record);
r = expectStatus('the manager starts the day (agent)', await mgrAgent.post('/activity/start-day', { startedAt: iso(plus(new Date(), -9)) }), 200);
const mgrStart = new Date(data(r)?.workday?.startedAt);
r = expectStatus('the manager logs an earlier meeting', await mgrAgent.post('/meetings/past', { startedAt: iso(plus(mgrStart, 1)), durationMin: 5, agenda: 'Hiring panel', participants: [] }), 200);
const mgrMeeting = data(r)?.meeting;
check('pending for the Super Admins', mgrMeeting?.approvalStatus === 'PENDING', mgrMeeting);
r = expectStatus('the manager starts the morning', await mgrAgent.post('/breaks/start', { kind: 'MORNING' }), 200);
expectStatus('Sneha starts the day', await sneha.post('/activity/start-day', {}), 200);
r = await sneha.post('/breaks/start', { kind: 'MORNING' });
check('late start needs a reason [422 REASON_REQUIRED, LATE]', r.status === 422 && r.body?.error?.code === 'REASON_REQUIRED' && r.body.error.details.timing === 'LATE', r.body);
r = expectStatus('Sneha starts late with a reason', await sneha.post('/breaks/start', { kind: 'MORNING', reason: 'Was on a client call' }), 200);
const snehaBreak = data(r)?.record;
check('LATE and pending', snehaBreak?.timing === 'LATE' && snehaBreak.approvalStatus === 'PENDING' && !!snehaBreak.dueAt, snehaBreak);
r = expectStatus('the manager approves the late start while it runs', await mgr.post(`/approvals/break/${snehaBreak?.id}/approve`, {}), 200);
check('APPROVED', data(r)?.status === 'APPROVED', data(r));
const breaksStartedAt = Date.now();

// ---------------------------------------------------------------------------------------
console.log('\n# End Day gate: skips need comments (3.1 agents only)');
const T2 = new Date();
const gateShift = await makeShift('Gate', T2, [
  { kind: 'MORNING', at: -7, durationMin: 1, before: 0, after: 1 },
  { kind: 'LUNCH', at: -5, durationMin: 1, before: 0, after: 1 },
  { kind: 'EVENING', at: -3, durationMin: 1, before: 0, after: 1 },
], { ringLeadMin: 0, ringDurationMin: 1 });
await assign(mgr, [anitaP.id], gateShift, 'manager puts Anita');
// Yesterday's auto-skip that nobody commented on (what the 5-minute job leaves behind).
const yClose = wallToUtc(yesterday, '12:00');
const ySkip = await db.breakRecord.create({
  data: {
    userId: anitaP.id,
    date: yesterday,
    kind: 'MORNING',
    seq: 0,
    presenceType: 'BREAK',
    shiftName: 'General',
    scheduledStart: wallToUtc(yesterday, '11:00'),
    durationMin: 15,
    windowOpen: wallToUtc(yesterday, '10:30'),
    windowClose: yClose,
    startedAt: yClose,
    timing: 'OUTSIDE_WINDOW',
    minutesOff: 0,
    reason: null,
    source: 'SYSTEM',
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: mgr.user.id,
    outcome: 'AUTO_SKIPPED',
    dueAt: new Date(yClose.getTime() + 48 * 3600_000),
    createdAt: yClose,
  },
});
r = expectError('skip a break whose window closed', await anita.post('/breaks/skip', { kind: 'MORNING', reason: 'Client escalation call' }), 409, 'BREAK_WINDOW_CLOSED');
check('with the closing time', !!r.body?.error?.details?.closedAt, r.body?.error);
r = expectStatus('Anita starts the day dated 9 minutes back', await anita.post('/activity/start-day', { startedAt: iso(plus(new Date(), -9)) }), 200);
r = expectStatus('her workday', await anita.get('/workday/me/today'), 200);
let waiting = data(r)?.skipsNeedingComment ?? [];
check('three owed breaks became AUTO_SKIPPED, plus yesterday\'s: 4 need comments', waiting.length === 4 && waiting.every((s) => s.outcome === 'AUTO_SKIPPED' && s.minChars === 10), waiting);
check('newest first, yesterday last', waiting[3]?.id === ySkip.id && waiting[3]?.date === yesterday && waiting[0]?.date === today, waiting.map((s) => [s.kind, s.date]));
r = expectStatus('her break day', await anita.get('/breaks/me/today'), 200);
const slots = data(r)?.breaks ?? [];
check('each slot holds its AUTO_SKIPPED record at the window close', slots.length === 3 && slots.every((s) => s.record?.outcome === 'AUTO_SKIPPED' && s.record.needsComment === true && s.record.startedAt === s.windowClose && s.record.reason === null), slots.map((s) => s.record));
const [autoM, autoL, autoE] = slots.map((s) => s.record?.id);
r = expectError('3.1 End Day', await anita.post('/activity/end-day', {}), 409, 'SKIP_COMMENTS_REQUIRED');
check('lists all four', r.body?.error?.details?.breaks?.length === 4, r.body?.error?.details);
r = await anita.get('/workday/me/today');
check('the day stays open', data(r)?.state === 'OPEN', data(r)?.state);
expectStatus('the manager approves yesterday\'s skip', await mgr.post(`/approvals/break/${ySkip.id}/approve`, {}), 200);
r = expectError('3.1 End Day again', await anita.post('/activity/end-day', {}), 409, 'SKIP_COMMENTS_REQUIRED');
check('a decided skip no longer needs a comment (3 left)', r.body?.error?.details?.breaks?.length === 3 && !r.body.error.details.breaks.some((b) => b.id === ySkip.id), r.body?.error?.details);
r = await anita.post('/activity/end-day', { comments: [{ breakId: autoM, comment: 'Short' }] });
check('a short comment fails the call [422 COMMENT_INVALID, breakId, TOO_SHORT]', r.status === 422 && r.body?.error?.code === 'COMMENT_INVALID' && r.body.error.details.breakId === autoM && r.body.error.details.problem === 'TOO_SHORT' && r.body.error.details.minChars === 10, r.body);
r = await anita.post('/activity/end-day', { comments: [{ breakId: autoM, comment: 'Back-to-back client calls' }, { breakId: staffSkip?.id, comment: 'Not mine to comment on' }] });
check('a comment on someone else\'s break fails the call (NOT_YOURS)', r.status === 422 && r.body?.error?.details?.problem === 'NOT_YOURS', r.body);
r = await anita.get('/breaks/me/today');
check('and nothing was saved', data(r)?.breaks?.[0]?.record?.reason === null, data(r)?.breaks?.[0]?.record);
r = expectError('one comment of three', await anita.post('/activity/end-day', { comments: [{ breakId: autoM, comment: 'Back-to-back client calls' }] }), 409, 'SKIP_COMMENTS_REQUIRED');
check('still blocked by the other two', r.body?.error?.details?.breaks?.map((b) => b.id).sort().join() === [autoL, autoE].sort().join(), r.body?.error?.details);
r = await anita.get('/breaks/me/today');
check('the morning comment was saved', data(r)?.breaks?.[0]?.record?.reason === 'Back-to-back client calls' && !!data(r).breaks[0].record.commentedAt && data(r).breaks[0].record.needsComment === false, data(r)?.breaks?.[0]?.record);
r = await anita.post(`/breaks/${autoL}/comment`, { comment: 'short' });
check('comment too short [422 REASON_REQUIRED, minChars 10]', r.status === 422 && r.body?.error?.code === 'REASON_REQUIRED' && r.body.error.details.minChars === 10, r.body);
expectStatus('comment too long (over 500)', await anita.post(`/breaks/${autoL}/comment`, { comment: 'x'.repeat(501) }), 400);
r = expectStatus('comment the lunch', await anita.post(`/breaks/${autoL}/comment`, { comment: '  Lunch call   with the US team ' }), 200);
check('stored as the reason', data(r)?.record?.reason === 'Lunch call with the US team' && !!data(r)?.record?.commentedAt, data(r)?.record);
expectError('comment it twice', await anita.post(`/breaks/${autoL}/comment`, { comment: 'Changing my mind now' }), 409, 'COMMENT_NOT_NEEDED');
expectStatus('comment on someone else\'s skip', await staff.post(`/breaks/${autoE}/comment`, { comment: 'Not mine to comment on' }), 403);
r = expectStatus('the 3.0 agent ends the day anyway', await anitaOld.post('/activity/end-day', {}), 200);
check('older agents are not gated', data(r)?.workday?.state === 'ENDED', data(r)?.workday?.state);
r = expectStatus('3.1 Start Day again', await anita.post('/activity/start-day', {}), 200);
check('resumed', data(r)?.resumed === true, data(r));
r = expectStatus('3.1 End Day with the last comment', await anita.post('/activity/end-day', { comments: [{ breakId: autoE, comment: 'Production issue on the bridge' }, { breakId: autoM, comment: 'A second try is ignored' }] }), 200);
check('ended, nothing left to comment', data(r)?.workday?.state === 'ENDED' && data(r)?.workday?.skipsNeedingComment?.length === 0, data(r)?.workday);
r = await anita.get('/breaks/me/today');
check('a skip that had its comment keeps it', data(r)?.breaks?.[0]?.record?.reason === 'Back-to-back client calls', data(r)?.breaks?.[0]?.record);

// ---------------------------------------------------------------------------------------
const waitMs = breaksStartedAt + 66_000 - Date.now();
if (waitMs > 0) {
  console.log(`\n  ..   waiting ${Math.ceil(waitMs / 1000)} s for the breaks to run over`);
  await sleep(waitMs);
}
console.log('\n# Back late from a break');
r = await farhan.post('/breaks/end', { askToCount: true, overrunReason: 'short' });
check('asking needs a reason [422 REASON_REQUIRED, minChars, overrunSec]', r.status === 422 && r.body?.error?.code === 'REASON_REQUIRED' && r.body.error.details.minChars === 10 && r.body.error.details.overrunSec > 0, r.body);
r = expectStatus('Farhan asks to count the minutes', await farhan.post('/breaks/end', { askToCount: true, overrunReason: 'Client escalation on the line' }), 200);
const farhanBreak = data(r)?.record;
check('asked, pending, overrun stored', farhanBreak?.overrunAsked === true && farhanBreak.approvalStatus === 'PENDING' && farhanBreak.overrunSec > 0 && farhanBreak.overrunReason === 'Client escalation on the line' && !!farhanBreak.dueAt, farhanBreak);
r = await farhan.get('/workday/me/today');
check('the asked minutes are pending plus', data(r)?.focus?.pendingPlusSec === farhanBreak?.overrunSec, data(r)?.focus);
r = expectStatus('the manager leaves the minutes out', await mgrAgent.post('/breaks/end', { askToCount: false }), 200);
check('overrun stored, not asked, no approval', data(r)?.record?.overrunSec > 0 && data(r)?.record?.overrunAsked === false && data(r)?.record?.approvalStatus === 'NOT_REQUIRED', data(r)?.record);
r = await mgrAgent.get('/workday/me/today');
check('the whole break stays out of focus', data(r)?.focus?.breakSec >= 60 && data(r)?.focus?.pendingPlusSec === 0, data(r)?.focus);
r = expectStatus('Sneha asks to count hers', await sneha.post('/breaks/end', { askToCount: true, overrunReason: 'Took a long client call' }), 200);
const snehaEnd = data(r)?.record;
check('the approved late start is reopened to PENDING', snehaEnd?.approvalStatus === 'PENDING' && snehaEnd.overrunAsked === true && snehaEnd.decidedAt === null, snehaEnd);
check('its 48 hours restart', new Date(snehaEnd?.dueAt).getTime() > new Date(snehaBreak?.dueAt).getTime() + 30_000, { before: snehaBreak?.dueAt, after: snehaEnd?.dueAt });
r = expectStatus('the 3.0 agent sends only an overrun reason', await ravi.post('/breaks/end', { overrunReason: 'Client call ran over' }), 200);
const raviEnd = data(r)?.record;
check('taken as a request to count them', raviEnd?.overrunAsked === true && raviEnd.approvalStatus === 'PENDING' && raviEnd.overrunSec > 0, raviEnd);
r = expectStatus('the 3.0 agent ends the day', await ravi.post('/activity/end-day', {}), 200);
expectStatus('and again (idempotent)', await ravi.post('/activity/end-day', {}), 200);
r = await ravi.post('/activity/report', { app: 'Outlook', idle: false });
check('3.0 capture stops after End Day', data(r)?.shouldCapture === false, data(r));

console.log('\n# A meeting closed by a break heals on read');
expectStatus('a plain lunch (closes the meeting)', await staffWeb.post('/presence/start', { type: 'LUNCH' }), 200);
r = expectStatus('my meetings today', await staff.get('/meetings/me/today'), 200);
const healed = data(r)?.items?.find((m) => m.id === review?.id);
check('the review ended when the lunch started', healed && healed.inProgress === false && !!healed.endedAt && healed.durationSec >= 60, healed);
expectStatus('lunch ends', await staffWeb.post('/presence/end', {}), 200);
r = expectStatus('the manager approves the review', await mgr.post(`/approvals/meeting/${review?.id}/approve`, { note: 'Good review' }), 200);
check('APPROVED: counted as focus time', data(r)?.status === 'APPROVED' && data(r)?.effect?.text === 'Counted as focus time' && data(r)?.decidedByName === 'Maya Reddy', data(r));
check('says who decided it (decidedById)', data(r)?.decidedById === mgr.user.id, data(r)?.decidedById);

// ---------------------------------------------------------------------------------------
console.log('\n# Approvals');
// One of the manager's items is past its 48 hours and was escalated (the 15-minute job's work).
const overdueAt = new Date(Date.now() - 2 * 3600_000);
await db.breakRecord.update({ where: { id: staffSkip.id }, data: { dueAt: overdueAt, escalatedAt: new Date() } });
r = expectStatus('manager list (pending, mine)', await mgr.get('/approvals'), 200);
let items = data(r)?.items ?? [];
check('only items routed to the manager, all pending', items.length >= 8 && items.every((i) => team.includes(i.user.id) && i.status === 'PENDING'), items.map((i) => [i.user.name, i.category]));
check('overdue first, then by due time', items[0]?.id === staffSkip.id && items[0].overdue === true && items[0].dueInSec < 0 && items.every((x, i) => i === 0 || !x.dueAt || x.dueAt >= items[i - 1].dueAt), items.map((i) => i.dueAt));
check('the escalated item says so', items[0]?.escalated === true, items[0]);
const byId = (id) => items.find((i) => i.id === id);
check('a skip: −15 min if rejected', byId(staffSkip.id)?.category === 'BREAK_SKIP' && byId(staffSkip.id)?.effect?.text === '−15 min if rejected', byId(staffSkip.id)?.effect);
check('an overrun asked: +minutes if approved', byId(farhanBreak?.id)?.category === 'BREAK_OVERRUN' && byId(farhanBreak?.id)?.effect?.mode === 'PLUS', byId(farhanBreak?.id));
check('overrun wins over a late start', byId(snehaEnd?.id)?.category === 'BREAK_OVERRUN', byId(snehaEnd?.id)?.category);
check('auto-skips are in the list, commented', [autoM, autoL, autoE].every((id) => byId(id)?.category === 'BREAK_AUTO_SKIP' && byId(id)?.needsComment === false), [autoM, autoL, autoE].map((id) => byId(id)?.needsComment));
check('a logged meeting: −5 min if rejected', byId(P1?.id)?.category === 'MEETING_PAST' && byId(P1?.id)?.effect?.text === '−5 min if rejected', byId(P1?.id)?.effect);
r = await mgr.get('/approvals?scope=all');
check('a Manager asking for all still gets mine', data(r)?.meta?.total === data(await mgr.get('/approvals'))?.meta?.total, data(r)?.meta);
r = await mgr.get('/approvals?overdue=true');
check('overdue filter', data(r)?.items?.length === 1 && data(r).items[0].id === staffSkip.id, data(r)?.items?.map((i) => i.id));
r = await mgr.get('/approvals?type=MEETING&status=ALL');
check('type filter', data(r)?.items?.length >= 2 && data(r).items.every((i) => i.type === 'MEETING'), data(r)?.items?.map((i) => i.type));
r = await mgr.get('/approvals?category=BREAK_AUTO_SKIP');
check('category filter', data(r)?.items?.length === 3 && data(r).items.every((i) => i.category === 'BREAK_AUTO_SKIP'), data(r)?.items?.map((i) => i.category));
r = await mgr.get(`/approvals?userId=${anitaP.id}&status=ALL`);
check('person filter (decided ones too)', data(r)?.items?.length === 4 && data(r).items.every((i) => i.user.id === anitaP.id), data(r)?.items?.map((i) => i.user.name));
r = await mgr.get('/approvals?status=ALL');
items = data(r)?.items ?? [];
{
  const firstDecided = items.findIndex((i) => i.status !== 'PENDING');
  check('ALL: pending first, then decided', firstDecided > 0 && items.slice(firstDecided).every((i) => i.status !== 'PENDING'), items.map((i) => i.status));
}
expectStatus('bad status', await mgr.get('/approvals?status=MAYBE'), 400);
expectStatus('bad type in the path', await mgr.post(`/approvals/BREAK/${farhanBreak?.id}/approve`, {}), 400);
r = expectStatus('manager summary', await mgr.get('/approvals/summary'), 200);
check('counts: pending, overdue 1, escalated 1, approved today, 48 h', data(r)?.pending >= 8 && data(r)?.overdue === 1 && data(r)?.escalated === 1 && data(r)?.approvedToday >= 2 && data(r)?.slaHours === 48, data(r));
r = expectStatus('Super Admin mine', await sa.get('/approvals'), 200);
items = data(r)?.items ?? [];
check('holds what is routed to them and the pool', items.some((i) => i.id === nehaSkip?.id) && items.some((i) => i.id === mgrMeeting?.id), items.map((i) => i.user.name));
check('holds every escalated item, decidable', items.some((i) => i.id === staffSkip.id && i.escalated && i.canDecide), items.map((i) => i.id));
check('but not the manager\'s other items', !items.some((i) => i.id === farhanBreak?.id), items.map((i) => i.user.name));
r = await sa.get('/approvals?scope=all');
check('Super Admin all holds everything', data(r)?.items?.some((i) => i.id === farhanBreak?.id) && data(r)?.items?.some((i) => i.id === nehaSkip?.id), data(r)?.meta);
expectStatus('staff cannot open Approvals', await staff.get('/approvals'), 403);
expectStatus('staff cannot decide', await staffWeb.post(`/approvals/break/${farhanBreak?.id}/approve`, {}), 403);
r = expectStatus('staff waiting list (any role)', await staff.get('/approvals/me'), 200);
check('my items, pending first', data(r)?.items?.some((i) => i.id === staffSkip.id) && data(r)?.items?.every((i) => i.user.id === staff.user.id) && data(r)?.items?.[0]?.status === 'PENDING', data(r)?.items?.map((i) => i.status));
expectStatus('the manager cannot decide his own meeting', await mgr.post(`/approvals/meeting/${mgrMeeting?.id}/approve`, {}), 403);
expectStatus('nor one routed to the Super Admin', await mgr.post(`/approvals/break/${nehaSkip?.id}/approve`, {}), 403);
r = await mgr.post(`/approvals/meeting/${P1?.id}/reject`, {});
check('reject needs a note [400 NOTE_REQUIRED]', r.status === 400 && r.body?.error?.code === 'NOTE_REQUIRED', r.body);
r = expectStatus('reject the logged meeting', await mgr.post(`/approvals/meeting/${P1?.id}/reject`, { note: 'Not a work meeting' }), 200);
check('−5 min taken off', data(r)?.status === 'REJECTED' && data(r)?.effect?.text === '−5 min taken off' && data(r)?.decisionNote === 'Not a work meeting', data(r));
r = await staff.get('/workday/me/today');
check('focus loses the rejected meeting (rejectedMinusSec 300)', data(r)?.focus?.rejectedMinusSec === 300, data(r)?.focus);
r = expectStatus('bulk approve', await mgr.post('/approvals/bulk-approve', {
  items: [
    { type: 'break', id: farhanBreak?.id },
    { type: 'break', id: raviEnd?.id },
    { type: 'break', id: farhanBreak?.id },
    { type: 'break', id: nehaSkip?.id },
    { type: 'meeting', id: review?.id },
  ],
  note: 'Fine',
}), 200);
check('approves mine once, skips the rest with reasons', data(r)?.approved?.length === 2 && data(r)?.skipped?.length === 2 && data(r).skipped.every((s) => s.reason), data(r));
expectStatus('bulk of 201 items', await mgr.post('/approvals/bulk-approve', { items: Array.from({ length: 201 }, () => ({ type: 'break', id: farhanBreak?.id })) }), 400);
r = await farhan.get('/workday/me/today');
check('the approved overrun is added to focus', data(r)?.focus?.approvedPlusSec === farhanBreak?.overrunSec && data(r)?.focus?.pendingPlusSec === 0, data(r)?.focus);
expectStatus('another manager cannot reopen it', await kiran.post(`/approvals/break/${raviEnd?.id}/reopen`, {}), 403);
r = expectStatus('the decider reopens it', await mgr.post(`/approvals/break/${raviEnd?.id}/reopen`, {}), 200);
check('back to PENDING with a fresh due time', data(r)?.status === 'PENDING' && new Date(data(r)?.dueAt).getTime() > Date.now() + 47 * 3600_000, data(r));
expectError('reopen a pending item', await mgr.post(`/approvals/break/${raviEnd?.id}/reopen`, {}), 409, 'NOT_DECIDED');
r = expectStatus('legacy break approvals still work', await mgr.get('/breaks/approvals'), 200);
check('and list break records', Array.isArray(data(r)) && data(r).some((i) => i.id === raviEnd?.id), data(r)?.length);
await sleep(300);
r = await mgr.get('/notifications?limit=100');
let kinds = types(data(r));
check('manager notified: skip, auto-skip, comment, meeting, break', ['SKIP_REQUESTED', 'AUTO_SKIP_REQUESTED', 'SKIP_COMMENT_ADDED', 'MEETING_REQUESTED', 'BREAK_APPROVAL_REQUESTED'].every((k) => kinds.has(k)), [...kinds]);
r = await staff.get('/notifications?limit=100');
check('staff notified of the meeting decisions', types(data(r)).has('MEETING_DECIDED'), [...types(data(r))]);

// ---------------------------------------------------------------------------------------
console.log('\n# Manager End Day and overdue approvals');
r = expectStatus('manager workday', await mgrAgent.get('/workday/me/today'), 200);
check('shows the overdue item and the block', data(r)?.overdueApprovals === 1 && data(r)?.endDayBlockedByOverdue === true, data(r));
r = expectError('manager End Day (3.1)', await mgrAgent.post('/activity/end-day', {}), 409, 'APPROVALS_OVERDUE');
check('with the count and the oldest due time', r.body?.error?.details?.count === 1 && r.body.error.details.oldestDueAt === iso(overdueAt), r.body?.error?.details);
expectStatus('Super Admin turns the block off', await sa.patch('/settings', { blockManagerEndDayWhenOverdue: false }), 200);
r = await mgrAgent.get('/workday/me/today');
check('no longer blocked', data(r)?.endDayBlockedByOverdue === false && data(r)?.overdueApprovals === 1, data(r));
r = expectStatus('manager End Day now', await mgrAgent.post('/activity/end-day', {}), 200);
check('ended', data(r)?.workday?.state === 'ENDED', data(r)?.workday?.state);
expectStatus('Super Admin turns it back on', await sa.patch('/settings', { blockManagerEndDayWhenOverdue: true }), 200);
await db.breakRecord.update({ where: { id: nehaSkip.id }, data: { dueAt: overdueAt } });
r = expectStatus('Super Admin workday', await saAgent.get('/workday/me/today'), 200);
check('overdue for a Super Admin, never blocking', data(r)?.overdueApprovals === 1 && data(r)?.endDayBlockedByOverdue === false, data(r));
r = expectStatus('Super Admin End Day (3.1)', await saAgent.post('/activity/end-day', {}), 200);

// ---------------------------------------------------------------------------------------
console.log('\n# Month lock');
r = expectError('lock this month (it has not ended)', await sa.post(`/reports/months/${month}/lock`, {}), 409, 'MONTH_NOT_ENDED');
check('names the month', r.body?.error?.details?.month === month, r.body?.error?.details);
// A worked day in August with a decided skip.
const aug = '2026-08-31';
await db.workSession.create({ data: { userId: staff.user.id, date: aug, startedAt: wallToUtc(aug, '09:30'), endedAt: wallToUtc(aug, '18:30'), endReason: 'USER', source: 'BACKFILL' } });
const augSkip = await db.breakRecord.create({
  data: {
    userId: staff.user.id, date: aug, kind: 'MORNING', seq: 0, presenceType: 'BREAK', shiftName: 'General',
    scheduledStart: wallToUtc(aug, '11:00'), durationMin: 15, windowOpen: wallToUtc(aug, '10:30'), windowClose: wallToUtc(aug, '12:00'),
    startedAt: wallToUtc(aug, '11:02'), timing: 'ON_TIME', minutesOff: 0, reason: 'Client escalation call', source: 'AGENT',
    approvalStatus: 'APPROVED', approverRole: 'MANAGER', approverId: mgr.user.id, decidedById: mgr.user.id, decidedAt: wallToUtc(aug, '15:00'),
    outcome: 'SKIPPED', createdAt: wallToUtc(aug, '11:02'),
  },
});
// For now, also a skip still waiting and a working day nobody ended.
const augPending = await db.breakRecord.create({
  data: {
    userId: staff.user.id, date: aug, kind: 'LUNCH', seq: 0, presenceType: 'LUNCH', shiftName: 'General',
    scheduledStart: wallToUtc(aug, '13:00'), durationMin: 30, windowOpen: wallToUtc(aug, '12:30'), windowClose: wallToUtc(aug, '14:00'),
    startedAt: wallToUtc(aug, '13:01'), timing: 'ON_TIME', minutesOff: 0, reason: 'Payer call ran over', source: 'AGENT',
    approvalStatus: 'PENDING', approverRole: 'MANAGER', approverId: mgr.user.id, outcome: 'SKIPPED',
    dueAt: wallToUtc('2026-09-02', '13:01'), createdAt: wallToUtc(aug, '13:01'),
  },
});
const augOpen = await db.workSession.create({ data: { userId: kiranP.id, date: '2026-08-30', startedAt: wallToUtc('2026-08-30', '09:30'), source: 'AGENT' } });
r = expectError('lock August while a day in it is still open', await sa.post('/reports/months/2026-08/lock', {}), 409, 'OPEN_SESSIONS');
check('says how many', r.body?.error?.details?.count === 1, r.body?.error?.details);
await db.workSession.delete({ where: { id: augOpen.id } });
r = expectError('lock August while an item in it waits', await sa.post('/reports/months/2026-08/lock', {}), 409, 'PENDING_APPROVALS');
check('says how many', r.body?.error?.details?.count === 1, r.body?.error?.details);
expectStatus('the manager decides it', await mgr.post(`/approvals/break/${augPending.id}/approve`, {}), 200);
expectStatus('a manager cannot lock', await mgr.post('/reports/months/2026-08/lock', {}), 403);
r = await sa.get('/reports/months/2026-13/lock');
check('not a month [400, field month]', r.status === 400 && r.body?.error?.details?.field === 'month', r.body);
expectStatus('a future month', await sa.post('/reports/months/2099-01/lock', {}), 400);
expectStatus('a month before any work', await sa.post('/reports/months/2026-07/lock', {}), 400);
r = expectStatus('Super Admin locks August', await sa.post('/reports/months/2026-08/lock', {}), 200);
check('locked, by whom, nothing pending', data(r)?.locked === true && data(r)?.lockedByName === 'Praveen (Super Admin)' && data(r)?.pending === 0 && !!data(r)?.lockedAt, data(r));
r = expectStatus('locking again is harmless', await sa.post('/reports/months/2026-08/lock', {}), 200);
r = expectStatus('the manager sees the lock', await mgr.get('/reports/months/2026-08/lock'), 200);
check('locked', data(r)?.locked === true, data(r));
expectError('reopen in a locked month (manager)', await mgr.post(`/approvals/break/${augSkip.id}/reopen`, {}), 409, 'MONTH_LOCKED');
expectError('reopen in a locked month (Super Admin)', await sa.post(`/approvals/break/${augSkip.id}/reopen`, {}), 409, 'MONTH_LOCKED');
r = await mgr.get(`/approvals?status=ALL&date=${aug}`);
item = data(r)?.items?.find((i) => i.id === augSkip.id);
check('the item says locked and cannot be decided', item?.locked === true && item.canDecide === false, item);
r = expectStatus('August for the team', await sa.get('/reports/team/month?month=2026-08'), 200);
check('read from the snapshot', data(r)?.locked === true && data(r)?.scope === 'ALL', { locked: data(r)?.locked, scope: data(r)?.scope });
check('only the worked day counts (days before joining are off)', data(r)?.totals?.workdays === 1 && data(r)?.totals?.full === 1, data(r)?.totals);
r = expectStatus('staff August', await mgr.get(`/reports/person/${staff.user.id}/month?month=2026-08`), 200);
check('31 Aug FULL, locked', data(r)?.locked === true && data(r)?.days?.[30]?.dayClass === 'FULL' && data(r)?.days?.[0]?.dayClass === 'OFF', data(r)?.days?.slice(29));
r = expectStatus('Super Admin unlocks', await sa.del('/reports/months/2026-08/lock'), 200);
check('unlocked', data(r)?.locked === false && data(r)?.lockedAt === null, data(r));
r = expectStatus('reopen works again', await mgr.post(`/approvals/break/${augSkip.id}/reopen`, {}), 200);
check('PENDING', data(r)?.status === 'PENDING', data(r)?.status);
expectStatus('and approve again', await mgr.post(`/approvals/break/${augSkip.id}/approve`, {}), 200);

// ---------------------------------------------------------------------------------------
console.log('\n# A missed End Day closes at the last input');
// Kiran left a session open yesterday; the last keyboard input was 12:00. Two
// auto-skips were made while it stayed open: the morning one (11:00) stands, the
// evening one (16:00, after the real end) was never owed.
const kiranOpen = await db.workSession.create({ data: { userId: kiranP.id, date: yesterday, startedAt: wallToUtc(yesterday, '09:30'), source: 'AGENT' } });
await db.activitySample.create({ data: { userId: kiranP.id, date: yesterday, at: wallToUtc(yesterday, '12:00'), durationSec: 60, idle: false, app: 'EXCEL.EXE' } });
const kiranSkip = (kind, hmStart, len) => db.breakRecord.create({
  data: {
    userId: kiranP.id, date: yesterday, kind, seq: 0, presenceType: kind === 'LUNCH' ? 'LUNCH' : 'BREAK', shiftName: 'General',
    scheduledStart: wallToUtc(yesterday, hmStart), durationMin: len, windowOpen: wallToUtc(yesterday, hmStart), windowClose: wallToUtc(yesterday, hmStart),
    startedAt: wallToUtc(yesterday, hmStart), timing: 'OUTSIDE_WINDOW', minutesOff: 0, source: 'SYSTEM',
    approvalStatus: 'PENDING', approverRole: 'SUPER_ADMIN', outcome: 'AUTO_SKIPPED', dueAt: wallToUtc(today, '23:00'),
  },
});
const kiranMorning = await kiranSkip('MORNING', '11:00', 15);
const kiranEvening = await kiranSkip('EVENING', '16:00', 15);
expectStatus('Kiran opens the portal (the lazy auto-close)', await kiran.get('/workday/me/today'), 200);
const closedKiran = await db.workSession.findUnique({ where: { id: kiranOpen.id } });
check('closed at the last input, AUTO_CLOSED', closedKiran?.endedAt?.getTime() === wallToUtc(yesterday, '12:00').getTime() && closedKiran.endReason === 'AUTO_CLOSED', closedKiran);
check('the auto-skip after the end is gone, the one before it stays',
  !(await db.breakRecord.findUnique({ where: { id: kiranEvening.id } })) && !!(await db.breakRecord.findUnique({ where: { id: kiranMorning.id } })));
r = expectStatus('Kiran today', await kiran.get('/workday/me/today'), 200);
check('not started, and yesterday ended over 12 hours ago: no lastEnded', data(r)?.state === 'NOT_STARTED' && data(r)?.lastEnded === null, data(r)?.lastEnded);
// Had yesterday's session ended an hour ago (a night shift), today shows it until it starts.
const anHourAgo = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000);
await db.workSession.update({ where: { id: kiranOpen.id }, data: { endedAt: anHourAgo } });
r = expectStatus('Kiran today, an hour after the end', await kiran.get('/workday/me/today'), 200);
d = data(r);
check('lastEnded: yesterday, its end and its focus', d?.state === 'NOT_STARTED' && d.focus.focusSec === 0 &&
  d.lastEnded?.date === yesterday && d.lastEnded.endedAt === anHourAgo.toISOString() &&
  d.lastEnded.focusSec === Math.round((anHourAgo.getTime() - wallToUtc(yesterday, '09:30').getTime()) / 1000), d?.lastEnded);
await db.workSession.update({ where: { id: kiranOpen.id }, data: { endedAt: wallToUtc(yesterday, '12:00') } });
await db.breakRecord.update({ where: { id: kiranMorning.id }, data: { approvalStatus: 'APPROVED', decidedById: sa.user.id, decidedAt: new Date() } });

console.log('\n# Activity is for managers');
r = expectStatus('staff report a sample', await staff.post('/activity/report', { app: 'EXCEL.EXE', title: 'Claims', idle: false }), 200);
check('the ack has no active time', data(r)?.activeSec === 0 && data(r)?.remainingSec === data(r)?.workingBasisSec && data(r)?.clockedOut === false, data(r));
for (const path of ['/activity/me/current', `/activity/user/${staff.user.id}/current`]) {
  r = expectStatus(`staff ${path}`, await staff.get(path), 200);
  check('status, but no app, title or URL', typeof data(r)?.status === 'string' && data(r)?.app === null && data(r)?.title === null && data(r)?.url === null, data(r));
}
expectStatus('staff analytics (even own)', await staff.get(`/analytics/${staff.user.id}`), 403);
expectStatus('manager analytics for a report', await mgr.get(`/analytics/${staff.user.id}`), 200);
expectStatus('staff productivity score (even own)', await staff.get(`/productivity/${staff.user.id}`), 403);
expectStatus('manager productivity for a report', await mgr.get(`/productivity/${staff.user.id}`), 200);
r = expectStatus('staff own day', await staff.get('/activity/me/today'), 200);
check('staff see no activity numbers', data(r)?.activeSec === 0 && data(r)?.idleSec === 0 && data(r)?.hourly?.length === 0 && data(r)?.topApps?.length === 0, data(r));
r = expectStatus('staff own day by id', await staff.get(`/activity/user/${staff.user.id}/daily`), 200);
check('also without numbers', data(r)?.activeSec === 0 && data(r)?.hourly?.length === 0, data(r));
expectStatus('staff hourly (even own)', await staff.get(`/activity/user/${staff.user.id}/hourly`), 403);
r = expectStatus('manager sees the day', await mgr.get(`/activity/user/${staff.user.id}/daily`), 200);
check('with hours', data(r)?.hourly?.length === 24, data(r)?.hourly?.length);
r = expectStatus('manager hourly for a report', await mgr.get(`/activity/user/${staff.user.id}/hourly`), 200);
check('24 hours with active minutes', data(r)?.hours?.length === 24 && typeof data(r)?.activeMin === 'number' && data(r)?.date === today, data(r));
expectStatus('manager hourly outside the team', await mgr.get(`/activity/user/${nehaP.id}/hourly`), 403);
expectStatus('Super Admin hourly for anyone', await sa.get(`/activity/user/${nehaP.id}/hourly`), 200);

console.log('\n# Team today');
r = expectStatus('staff ends the day', await staff.post('/activity/end-day', {}), 200);
r = expectStatus('manager team today', await mgr.get('/team/today'), 200);
d = data(r);
const rowOf = (id) => d?.rows?.find((x) => x.user.id === id);
check('five people, none from another team', d?.rows?.length === 5 && !rowOf(nehaP.id), d?.rows?.map((x) => x.user.name));
check('statuses: ended, ended, ended, working, working', rowOf(staff.user.id)?.status === 'DAY_ENDED' && rowOf(anitaP.id)?.status === 'DAY_ENDED' && rowOf(raviP.id)?.status === 'DAY_ENDED' && rowOf(farhanP.id)?.status === 'WORKING' && rowOf(snehaP.id)?.status === 'WORKING', d?.rows?.map((x) => [x.user.name, x.status]));
check('totals: 5 started, 3 ended, late starts, pending', d?.totals?.started === 5 && d.totals.ended === 3 && d.totals.notStarted === 0 && d.totals.lateStarts >= 1 && d.totals.pendingApprovals >= 1, d?.totals);
check('break cells: skipped and auto-skipped', rowOf(staff.user.id)?.breaks?.[0]?.status === 'SKIPPED' && rowOf(anitaP.id)?.breaks?.every((b) => b.status === 'AUTO_SKIPPED'), [rowOf(staff.user.id)?.breaks?.map((b) => b.status), rowOf(anitaP.id)?.breaks?.map((b) => b.status)]);
expectStatus('staff cannot open Team today', await staff.get('/team/today'), 403);
expectStatus('a manager cannot ask for another team', await mgr.get(`/team/today?managerId=${kiranP.id}`), 403);
r = expectStatus('Super Admin: one manager\'s team', await sa.get(`/team/today?managerId=${mgr.user.id}`), 200);
check('the same five', data(r)?.rows?.length === 5, data(r)?.rows?.length);

// ---------------------------------------------------------------------------------------
console.log('\n# Reports');
expectStatus('staff cannot open reports', await staff.get('/reports/people'), 403);
r = expectStatus('manager: people', await mgr.get('/reports/people'), 200);
check('the five direct reports, not the manager', data(r)?.items?.length === 5 && data(r).items.every((p) => team.includes(p.id)), data(r)?.items?.map((p) => p.name));
r = expectStatus('Super Admin: people', await sa.get('/reports/people'), 200);
check('everyone, managers and Super Admins too', [mgr.user.id, sa.user.id, nehaP.id, kiranP.id].every((id) => data(r)?.items?.some((p) => p.id === id)), data(r)?.items?.length);
expectStatus('manager: a day of someone outside the team', await mgr.get(`/reports/person/${nehaP.id}/day`), 403);
expectStatus('manager: a month of someone outside the team', await mgr.get(`/reports/person/${nehaP.id}/month`), 403);
expectStatus('manager: own report as a person', await mgr.get(`/reports/person/${mgr.user.id}/day`), 403);
expectStatus('another manager: my staff', await kiran.get(`/reports/person/${staff.user.id}/month`), 403);
expectStatus('manager: team month naming an outsider', await mgr.get(`/reports/team/month?userIds=${staff.user.id},${nehaP.id}`), 403);
expectStatus('manager: another manager\'s team', await mgr.get(`/reports/team/month?managerId=${kiranP.id}`), 403);
expectStatus('unknown person', await sa.get('/reports/person/00000000-0000-4000-8000-00000000abcd/day'), 404);
expectStatus('bad day', await mgr.get(`/reports/person/${staff.user.id}/day?date=2026-02-30`), 400);
r = expectStatus('a person\'s day', await mgr.get(`/reports/person/${staff.user.id}/day`), 200);
d = data(r);
const kindsOn = new Set((d?.timeline ?? []).map((s) => s.kind));
check('summary: ended today, late start, the skip and two meetings', d?.summary?.date === today && d.summary.skipped === 1 && d.summary.meetings === 2 && (d.summary.lateStart?.minutes ?? 0) > 100, d?.summary);
check('timeline: work, lunch, meeting and the gap between sessions', ['WORK', 'LUNCH', 'MEETING', 'OFF'].every((k) => kindsOn.has(k)), [...kindsOn]);
check('skips, breaks, meetings, approvals and 24 hours', d?.skips?.[0]?.outcome === 'SKIPPED' && d.breaks.length >= 3 && d.meetings.length === 2 && d.approvals.length >= 3 && d.hourly.length === 24, { skips: d?.skips, approvals: d?.approvals?.length });
r = expectStatus('team day', await mgr.get(`/reports/team/day?date=${today}`), 200);
check('a row per report', data(r)?.rows?.length === 5, data(r)?.rows?.length);
r = expectStatus('team month', await mgr.get('/reports/team/month'), 200);
d = data(r);
check('scope TEAM, unlocked, a row per report', d?.scope === 'TEAM' && d.locked === false && d.month === month && d.rows.length === 5 && d.totals.people === 5, { scope: d?.scope, rows: d?.rows?.length });
check('team totals are the sum of the rows', ['focusSec', 'expectedSec', 'skipped', 'autoSkipped', 'meetings', 'pending', 'workdays'].every((k) => d.totals[k] === d.rows.reduce((s, x) => s + x.totals[k], 0)), d?.totals);
check('each row has every day of the month', d?.rows?.every((x) => x.days.length === Number(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate())), d?.rows?.[0]?.days?.length);
r = expectStatus('a person\'s month', await mgr.get(`/reports/person/${anitaP.id}/month`), 200);
d = data(r);
check('month totals are the sum of the days', d?.totals?.autoSkipped === d?.days?.reduce((s, x) => s + x.autoSkipped, 0) && d.totals.autoSkipped === 4 && d.totals.focusSec === d.days.reduce((s, x) => s + x.focusSec, 0), d?.totals);
check('a heatmap row per day', d?.heatmap?.length === d?.days?.length && d.heatmap.every((h) => h.hours.length === 24), d?.heatmap?.length);
r = expectStatus('Super Admin team month', await sa.get('/reports/team/month'), 200);
check('scope ALL with everyone', data(r)?.scope === 'ALL' && data(r)?.rows?.length >= 9, data(r)?.rows?.length);
r = await sa.get(`/reports/team/month?managerId=${mgr.user.id}`);
check('Super Admin: one manager\'s team', data(r)?.scope === 'TEAM' && data(r)?.rows?.length === 5, data(r)?.rows?.length);
expectStatus('future month', await sa.get('/reports/team/month?month=2099-01'), 400);
expectStatus('not a month', await sa.get('/reports/team/month?month=2026-9'), 400);
r = await mgr.get('/reports/team/month/export.xlsx');
check('team export downloads', r.status === 200 && (r.headers?.['content-type'] ?? '').includes('spreadsheetml') && r.headers?.['content-disposition'] === `attachment; filename="rx-vision-${month}-team.xlsx"`, { status: r.status, headers: r.headers });
if (r.file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.file);
  const payroll = wb.getWorksheet('Payroll');
  const days = wb.getWorksheet('Days');
  check('two sheets: Payroll and Days', !!payroll && !!days, wb.worksheets.map((w) => w.name));
  check('Payroll: a header and a row per report', payroll?.rowCount === 6 && payroll.getRow(1).getCell(1).value === 'Name', payroll?.rowCount);
  check('Days: a row per report and day', days?.rowCount === 1 + 5 * new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate(), days?.rowCount);
  const anitaRow = payroll ? [...Array(payroll.rowCount).keys()].map((i) => payroll.getRow(i + 1)).find((row) => row.getCell(2).value === anitaP.email) : null;
  check('numbers are numbers (Anita: 4 auto-skipped)', anitaRow?.getCell(15).value === 4 && typeof anitaRow?.getCell(10).value === 'number', anitaRow?.values);
}
r = await mgr.get(`/reports/person/${staff.user.id}/month/export.xlsx`);
check('person export downloads with their name', r.status === 200 && r.headers?.['content-disposition'] === `attachment; filename="rx-vision-${month}-praveen-kumar.xlsx"`, r.headers?.['content-disposition']);
expectStatus('person export outside the team', await mgr.get(`/reports/person/${nehaP.id}/month/export.xlsx`), 403);
r = expectStatus('my report runs', await mgr.get('/reports/runs'), 200);
check('none yet this month', Array.isArray(data(r)?.items), data(r));

await db.$disconnect();
summary();
