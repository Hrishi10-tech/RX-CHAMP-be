// A realistic September 2026 for two managers' teams (12 people) and a night-shift
// agent reporting to the Super Admin (18:30 to 03:30), written straight into the local
// database, then checked through the API: focus against the SPEC 1.3 formula, day
// classes at the 80/40 boundaries, month and team totals, the night shift's working
// days, scope, the Excel export, and the month lock. The data stays in place afterwards
// (for screenshots).
// Needs a freshly reset and seeded database and a running API: see README.md.
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Client, check, expectStatus, summary, todayKey } from './lib.mjs';
import { openDb, TZ, wallToUtc } from './db.mjs';

const MONTH = '2026-09';
const DATES = Array.from({ length: 30 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
const GENERAL_ID = '00000000-0000-0000-0000-0000000000d1'; // the seeded default shift, 09:30 to 18:30 Mon to Sat
const PASSWORD = 'Sim-September-2026';
const EXPECTED_SEC = 8 * 3600; // 9 h minus 15 + 30 + 15 min of breaks
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const db = await openDb();

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

// ---------------------------------------------------------------------------------------
// People
const MANAGERS = [
  { key: 'arjun', first: 'Arjun', last: 'Mehta', department: 'Billing' },
  { key: 'kavya', first: 'Kavya', last: 'Menon', department: 'Coding' },
];
const STAFF = [
  { key: 'priya', first: 'Priya', last: 'Sharma', department: 'Billing', manager: 'arjun' },
  { key: 'rahul', first: 'Rahul', last: 'Verma', department: 'Billing', manager: 'arjun' },
  { key: 'deepa', first: 'Deepa', last: 'Nair', department: 'AR Calling', manager: 'arjun' },
  { key: 'vikram', first: 'Vikram', last: 'Singh', department: 'AR Calling', manager: 'arjun' },
  { key: 'meera', first: 'Meera', last: 'Iyer', department: 'Billing', manager: 'arjun' },
  { key: 'aditya', first: 'Aditya', last: 'Kulkarni', department: 'Coding', manager: 'kavya' },
  { key: 'pooja', first: 'Pooja', last: 'Patil', department: 'QA', manager: 'kavya' },
  { key: 'rohan', first: 'Rohan', last: 'Das', department: 'Coding', manager: 'kavya' },
  { key: 'ananya', first: 'Ananya', last: 'Bose', department: 'QA', manager: 'kavya' },
  { key: 'imran', first: 'Imran', last: 'Shaikh', department: 'Coding', manager: 'kavya' },
];
// Nights, reporting straight to the Super Admin (so neither team changes).
const NIGHT = [{ key: 'farah', first: 'Farah', last: 'Khan', department: 'AR Calling', manager: 'sa', night: true }];
const PEOPLE = [...MANAGERS, ...STAFF, ...NIGHT];
const emailOf = (p) => `${p.first}.${p.last}@timechamp.test`.toLowerCase();

if (await db.user.findFirst({ where: { email: emailOf(STAFF[0]) } })) {
  console.error(`${MONTH} is already simulated in this database. Reset it (README.md) to run the simulation again.`);
  await db.$disconnect();
  process.exit(2);
}

console.log('\n# People');
const sa = await new Actor('superadmin').login('admin@timechamp.test', 'admin123');
const id = {};
for (const p of PEOPLE) {
  const managerId = p.manager && p.manager !== 'sa' ? id[p.manager] : sa.user.id;
  const r = await sa.post('/users', {
    firstName: p.first,
    lastName: p.last,
    email: emailOf(p),
    password: PASSWORD,
    role: p.manager ? 'USER' : 'MANAGER',
    department: p.department,
    managerId,
  });
  id[p.key] = data(r)?.created?.[0]?.id;
  check(`SA adds ${p.first} ${p.last}`, r.status === 201 && !!id[p.key], r.body);
}
// They joined before September, so days without work count as absences.
await db.user.updateMany({ where: { id: { in: Object.values(id) } }, data: { createdAt: wallToUtc('2026-08-03', '09:00') } });
const managerOf = (key) => PEOPLE.find((p) => p.key === key)?.manager ?? null;

// The night shift (Mon to Sat, 18:30 to 03:30, breaks at 21:00, 23:30 and 01:30), assigned
// to Farah from August so September resolves to it.
const NIGHT_SHIFT = {
  name: 'Night (simulation)',
  start: '18:30',
  end: '03:30',
  workDays: [1, 2, 3, 4, 5, 6],
  ringLeadMin: 1, ringDurationMin: 5, reasonOnEarly: true, reasonOnLate: true, reasonMinChars: 10,
  overrunReason: true, overrunGraceMin: 3,
  breaks: [
    { kind: 'MORNING', enabled: true, startTime: '21:00', durationMin: 15, windowBeforeMin: 30, windowAfterMin: 60 },
    { kind: 'LUNCH', enabled: true, startTime: '23:30', durationMin: 30, windowBeforeMin: 30, windowAfterMin: 60 },
    { kind: 'EVENING', enabled: true, startTime: '01:30', durationMin: 15, windowBeforeMin: 30, windowAfterMin: 60 },
  ],
};
const nightRes = await sa.post('/shifts', NIGHT_SHIFT);
check('SA creates the night shift', nightRes.status === 201 && !!data(nightRes)?.id, nightRes.body);
const nightShift = data(nightRes);
await db.shiftAssignment.create({
  data: { target: 'USER', userId: id.farah, shiftId: nightShift.id, effectiveFrom: '2026-08-01', createdById: sa.user.id },
});
// The API reads shifts and assignments at most once a minute; an assignment made
// through it (the same shift from today) refreshes them at once.
const nightAssign = await sa.put('/shift-assignments/people', { userIds: [id.farah], shiftId: nightShift.id, effectiveFrom: todayKey() });
check('Farah on the night shift (from August)', nightAssign.status === 200, nightAssign.body);
const nameOf = (key) => {
  const p = PEOPLE.find((x) => x.key === key);
  return `${p.first} ${p.last}`;
};

// ---------------------------------------------------------------------------------------
// The month, as plans per person and day (minutes of the day, business time)
let seed = 20260901;
const rng = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const jitter = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const isoWeekday = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
};
/** Minutes (and seconds) of a business day as an instant. */
const at = (date, minutes, sec = 0) => new Date(wallToUtc(date, '00:00').getTime() + minutes * 60_000 + sec * 1000);
const SLOT = { MORNING: 11 * 60, LUNCH: 13 * 60, EVENING: 16 * 60 };
const LENGTH = { MORNING: 15, LUNCH: 30, EVENING: 15 };
// Night minutes run past midnight: 25 * 60 + 30 is 01:30 the next morning.
const NIGHT_SLOT = { MORNING: 21 * 60, LUNCH: 23 * 60 + 30, EVENING: 25 * 60 + 30 };
const isNight = (key) => !!PEOPLE.find((p) => p.key === key)?.night;
const slotsOf = (key) => (isNight(key) ? NIGHT_SLOT : SLOT);
const shiftStartOf = (key) => (isNight(key) ? 18 * 60 + 30 : 9 * 60 + 30);
/** The business-time calendar day of an instant (a night's samples after midnight). */
const calendarFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const calendarOf = (ms) => calendarFormat.format(new Date(ms));

function normalDay() {
  return {
    sessions: [{ start: 9 * 60 + 30 + jitter(-6, 6), end: 18 * 60 + 30 + jitter(-5, 15) }],
    breaks: ['MORNING', 'LUNCH', 'EVENING'].map((kind) => ({ kind, start: SLOT[kind] + jitter(0, 3), minutes: LENGTH[kind] })),
    meetings: [],
    quiet: [],
  };
}
function nightDay() {
  return {
    sessions: [{ start: 18 * 60 + 30 + jitter(-6, 6), end: 27 * 60 + 30 + jitter(-5, 15) }],
    breaks: ['MORNING', 'LUNCH', 'EVENING'].map((kind) => ({ kind, start: NIGHT_SLOT[kind] + jitter(0, 3), minutes: LENGTH[kind] })),
    meetings: [],
    quiet: [],
  };
}
const plan = {};
for (const p of PEOPLE) {
  plan[p.key] = {};
  for (const d of DATES) plan[p.key][d] = isoWeekday(d) === 7 ? null : p.night ? nightDay() : normalDay();
}
const day = (key, date) => plan[key][date];
const brk = (key, date, kind) => day(key, date).breaks.find((b) => b.kind === kind);
const decided = (by, status, note, date, minutes) => ({ status, by, note, at: at(date, minutes) });

// Absences, late starts, a half day, a resumed day, a missed End Day, a weekend.
plan.vikram['2026-09-08'] = null;
plan.vikram['2026-09-22'] = null;
plan.pooja['2026-09-15'] = null;
day('vikram', '2026-09-02').sessions[0].start = 9 * 60 + 58;
day('ananya', '2026-09-07').sessions[0].start = 9 * 60 + 47;
day('rohan', '2026-09-21').sessions[0].start = 10 * 60 + 5;
plan.pooja['2026-09-11'] = {
  sessions: [{ start: 9 * 60 + 30, end: 14 * 60 }],
  breaks: [{ kind: 'MORNING', start: 11 * 60, minutes: 15 }, { kind: 'LUNCH', start: 13 * 60, minutes: 30 }],
  meetings: [],
  quiet: [],
};
plan.meera['2026-09-10'] = {
  sessions: [{ start: 9 * 60 + 30, end: 12 * 60 + 50 }, { start: 14 * 60 + 15, end: 18 * 60 + 45 }],
  breaks: [{ kind: 'MORNING', start: 11 * 60 + 1, minutes: 15 }, { kind: 'EVENING', start: 16 * 60 + 2, minutes: 15 }],
  meetings: [],
  quiet: [],
};
day('rohan', '2026-09-14').sessions[0] = { start: 9 * 60 + 35, end: 17 * 60 + 5, autoClosed: true };
// Farah's nights: a late start, a missed End Day (closed at 02:10), a meeting after midnight.
day('farah', '2026-09-17').sessions[0].start = 18 * 60 + 52;
day('farah', '2026-09-21').sessions[0] = { start: 18 * 60 + 30, end: 26 * 60 + 10, autoClosed: true };
plan.rahul['2026-09-13'] = { sessions: [{ start: 10 * 60, end: 14 * 60 }], breaks: [], meetings: [], quiet: [] };

// The 80% and 40% boundaries on Thursday 24 September (to the second).
const exact = (endMin, endSec, kinds) => ({
  sessions: [{ start: 9 * 60 + 30, end: endMin, endSec }],
  breaks: kinds.map((kind) => ({ kind, start: SLOT[kind], minutes: LENGTH[kind] })),
  meetings: [],
  quiet: [],
});
plan.priya['2026-09-24'] = exact(16 * 60 + 54, 0, ['MORNING', 'LUNCH', 'EVENING']); // 23040 s: FULL
plan.rahul['2026-09-24'] = exact(16 * 60 + 53, 59, ['MORNING', 'LUNCH', 'EVENING']); // 23039 s: HALF
plan.deepa['2026-09-24'] = exact(12 * 60 + 57, 0, ['MORNING']); // 11520 s: HALF
plan.vikram['2026-09-24'] = exact(12 * 60 + 56, 59, ['MORNING']); // 11519 s: ABSENT

// Breaks off schedule, overruns, skips and auto-skips, with their decisions.
Object.assign(brk('priya', '2026-09-03', 'MORNING'), {
  start: 10 * 60 + 40, timing: 'EARLY', minutesOff: 20, reason: 'Client moved the morning call',
  decision: decided('arjun', 'APPROVED', null, '2026-09-03', 12 * 60),
});
Object.assign(brk('rahul', '2026-09-04', 'LUNCH'), {
  start: 13 * 60 + 25, timing: 'LATE', minutesOff: 25, reason: 'Finishing a claims batch',
  decision: decided('arjun', 'REJECTED', 'Please plan lunch on time', '2026-09-05', 10 * 60),
});
Object.assign(brk('deepa', '2026-09-09', 'LUNCH'), {
  start: 13 * 60, minutes: 40, overrunSec: 600, asked: 'Long call with a payer',
  decision: decided('arjun', 'APPROVED', 'Fine, it was a payer call', '2026-09-09', 17 * 60),
});
Object.assign(brk('aditya', '2026-09-10', 'MORNING'), {
  start: 11 * 60, minutes: 25, overrunSec: 600, asked: 'Production bug on a call',
  decision: decided('kavya', 'REJECTED', 'Please keep breaks short', '2026-09-11', 10 * 60),
});
Object.assign(brk('rohan', '2026-09-29', 'EVENING'), {
  start: 16 * 60, minutes: 20, overrunSec: 300, asked: 'Helping QA with a release', decision: null,
});
Object.assign(brk('imran', '2026-09-11', 'LUNCH'), { start: 13 * 60, minutes: 42, overrunSec: 720 });
const skip = (key, date, kind, minute, extra) => {
  const b = brk(key, date, kind);
  Object.assign(b, { outcome: 'SKIPPED', start: minute, minutes: LENGTH[kind], ...extra });
};
const autoSkip = (key, date, kind, extra) => {
  const b = brk(key, date, kind);
  Object.assign(b, { outcome: 'AUTO_SKIPPED', start: SLOT[kind] + 60, minutes: LENGTH[kind], timing: 'OUTSIDE_WINDOW', ...extra });
};
skip('meera', '2026-09-16', 'MORNING', 11 * 60 + 2, { reason: 'Month-end billing run', decision: decided('arjun', 'APPROVED', null, '2026-09-16', 15 * 60) });
skip('ananya', '2026-09-17', 'EVENING', 16 * 60 + 1, { reason: 'Regression suite running', decision: decided('kavya', 'REJECTED', 'Take your breaks, please', '2026-09-18', 10 * 60) });
skip('priya', '2026-09-30', 'MORNING', 11 * 60 + 1, { reason: 'Payer portal deadline today', decision: null });
autoSkip('vikram', '2026-09-18', 'LUNCH', { comment: 'Back-to-back denial calls', decision: decided('arjun', 'APPROVED', null, '2026-09-19', 11 * 60) });
autoSkip('pooja', '2026-09-23', 'EVENING', { decision: decided('kavya', 'REJECTED', 'Breaks are part of the day', '2026-09-24', 10 * 60) });
autoSkip('deepa', '2026-09-25', 'MORNING', { decision: null });

// Meetings: live (with a presence session) and logged afterwards.
day('kavya', '2026-09-15').meetings.push({ mode: 'LIVE', start: 14 * 60, end: 15 * 60, agenda: 'Sprint planning', with: ['aditya', 'rohan', 'imran'], decision: decided('sa', 'APPROVED', null, '2026-09-15', 17 * 60) });
day('rahul', '2026-09-22').meetings.push({ mode: 'LIVE', start: 15 * 60, end: 15 * 60 + 45, agenda: 'Vendor demo', with: [], decision: decided('arjun', 'REJECTED', 'Not related to billing work', '2026-09-23', 11 * 60) });
day('aditya', '2026-09-24').meetings.push({ mode: 'PAST', start: 10 * 60, end: 10 * 60 + 45, agenda: 'Code review with the client', with: ['kavya'], decision: decided('kavya', 'APPROVED', null, '2026-09-24', 16 * 60) });
day('imran', '2026-09-30').meetings.push({ mode: 'PAST', start: 15 * 60, end: 15 * 60 + 30, agenda: 'Architecture sync', with: ['rohan'], decision: null });
day('arjun', '2026-09-29').meetings.push({ mode: 'LIVE', start: 11 * 60 + 30, end: 12 * 60, agenda: 'Client escalation', with: ['priya'], decision: null });
day('farah', '2026-09-16').meetings.push({ mode: 'LIVE', start: 24 * 60 + 40, end: 25 * 60 + 10, agenda: 'Night handover with the US team', with: [], decision: decided('sa', 'APPROVED', null, '2026-09-17', 10 * 60) });

// Quiet hours (14:00 to 15:00 with 10 active minutes): five for Imran, two for Pooja.
for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) day('imran', d).quiet.push(14);
for (const d of ['2026-09-02', '2026-09-03']) day('pooja', d).quiet.push(14);

// ---------------------------------------------------------------------------------------
// Rows
const rows = { sessions: [], dayEnds: [], presence: [], breaks: [], meetings: [], samples: [] };
const expected = {}; // `${key}|${date}` -> focus parts and the day class
const APPS = {
  Billing: [['Excel', null], ['Google Chrome', 'payer.portal.test'], ['Outlook', null], ['Epic Resolute', null]],
  'AR Calling': [['Google Chrome', 'claims.portal.test'], ['Zoom', null], ['Excel', null], ['Outlook', null]],
  Coding: [['Visual Studio Code', null], ['Google Chrome', 'github.com'], ['Slack', null], ['Terminal', null]],
  QA: [['Google Chrome', 'jira.test'], ['Excel', null], ['Slack', null], ['Visual Studio Code', null]],
};
const seconds = (a, b) => Math.round((b.getTime() - a.getTime()) / 1000);
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / 1000;
const routeOf = (key) =>
  managerOf(key) === 'sa'
    ? { approverRole: 'SUPER_ADMIN', approverId: sa.user.id }
    : managerOf(key)
      ? { approverRole: 'MANAGER', approverId: id[managerOf(key)] }
      : { approverRole: 'SUPER_ADMIN', approverId: null };
const deciderId = (who) => (who === 'sa' ? sa.user.id : id[who]);
const pendingRefs = []; // { type, id, key, decider }

for (const p of PEOPLE) {
  const apps = APPS[p.department];
  for (const date of DATES) {
    const pl = plan[p.key][date];
    if (!pl) continue;
    const work = pl.sessions.map((s) => ({ start: at(date, s.start), end: at(date, s.end, s.endSec ?? 0), autoClosed: !!s.autoClosed }));
    for (const w of work) {
      rows.sessions.push({ id: randomUUID(), userId: id[p.key], date, startedAt: w.start, endedAt: w.end, endReason: w.autoClosed ? 'AUTO_CLOSED' : 'USER', source: 'AGENT' });
    }
    rows.dayEnds.push({ id: randomUUID(), userId: id[p.key], date, loginAt: work[0].start, endedAt: work[work.length - 1].end });
    const W = work.map((w) => ({ start: w.start.getTime(), end: w.end.getTime() }));
    const parts = { breakSec: 0, meetingSec: 0, approvedPlusSec: 0, pendingPlusSec: 0, rejectedMinusSec: 0, pendingMinusSec: 0 };
    const away = []; // break and lunch intervals (no samples)

    for (const b of pl.breaks) {
      const outcome = b.outcome ?? 'TAKEN';
      const scheduled = at(date, slotsOf(p.key)[b.kind]);
      const startedAt = at(date, b.start);
      const endedAt = at(date, b.start + b.minutes);
      // Only what someone had to review has an approval: off-schedule starts, overruns
      // asked for, skips. A null decision means it still waits.
      const reviewed = b.decision !== undefined || outcome !== 'TAKEN';
      const status = !reviewed ? 'NOT_REQUIRED' : b.decision ? b.decision.status : 'PENDING';
      const presenceId = outcome === 'TAKEN' ? randomUUID() : null;
      if (presenceId) {
        rows.presence.push({ id: presenceId, userId: id[p.key], type: b.kind === 'LUNCH' ? 'LUNCH' : 'BREAK', date, startedAt, endedAt, durationSec: seconds(startedAt, endedAt) });
        const iv = { start: startedAt.getTime(), end: endedAt.getTime() };
        away.push(iv);
        parts.breakSec += W.reduce((s, w) => s + overlap(iv, w), 0);
      }
      const recId = randomUUID();
      const createdAt = outcome === 'TAKEN' && b.asked ? endedAt : startedAt;
      rows.breaks.push({
        id: recId, userId: id[p.key], date, kind: b.kind, seq: 0, presenceType: b.kind === 'LUNCH' ? 'LUNCH' : 'BREAK',
        shiftId: p.night ? nightShift.id : GENERAL_ID, shiftName: p.night ? NIGHT_SHIFT.name : 'General', scheduledStart: scheduled, durationMin: LENGTH[b.kind],
        windowOpen: new Date(scheduled.getTime() - 30 * 60_000), windowClose: new Date(scheduled.getTime() + 60 * 60_000),
        ringStart: new Date(scheduled.getTime() - 60_000), ringEnd: new Date(scheduled.getTime() + 4 * 60_000),
        presenceSessionId: presenceId, startedAt, timing: b.timing ?? 'ON_TIME', minutesOff: b.minutesOff ?? 0,
        reason: outcome === 'AUTO_SKIPPED' ? (b.comment ?? null) : (b.reason ?? null),
        overrunReason: b.asked ?? null, source: outcome === 'AUTO_SKIPPED' ? 'SYSTEM' : 'AGENT',
        approvalStatus: status,
        approverRole: status === 'NOT_REQUIRED' ? null : routeOf(p.key).approverRole,
        approverId: status === 'NOT_REQUIRED' ? null : routeOf(p.key).approverId,
        decidedById: b.decision ? deciderId(b.decision.by) : null, decidedAt: b.decision?.at ?? null, decisionNote: b.decision?.note ?? null,
        outcome, overrunSec: outcome === 'TAKEN' ? (b.overrunSec ?? 0) : null, overrunAsked: !!b.asked,
        commentedAt: b.comment ? at(date, 18 * 60) : null,
        dueAt: status === 'NOT_REQUIRED' ? null : new Date(createdAt.getTime() + 48 * 3600_000),
        createdAt,
      });
      if (status === 'PENDING') pendingRefs.push({ type: 'break', id: recId, key: p.key, decider: managerOf(p.key) ?? 'sa' });
      if (outcome === 'TAKEN' && b.asked && status === 'APPROVED') parts.approvedPlusSec += b.overrunSec;
      if (outcome === 'TAKEN' && b.asked && status === 'PENDING') parts.pendingPlusSec += b.overrunSec;
      if (outcome !== 'TAKEN' && status === 'REJECTED') parts.rejectedMinusSec += LENGTH[b.kind] * 60;
      if (outcome !== 'TAKEN' && status === 'PENDING') parts.pendingMinusSec += LENGTH[b.kind] * 60;
    }

    for (const m of pl.meetings) {
      const startedAt = at(date, m.start);
      const endedAt = at(date, m.end);
      const iv = { start: startedAt.getTime(), end: endedAt.getTime() };
      const presenceId = m.mode === 'LIVE' ? randomUUID() : null;
      if (presenceId) {
        rows.presence.push({ id: presenceId, userId: id[p.key], type: 'MEETING', note: m.agenda, date, startedAt, endedAt, durationSec: seconds(startedAt, endedAt) });
      }
      const status = m.decision ? m.decision.status : 'PENDING';
      const recId = randomUUID();
      rows.meetings.push({
        id: recId, userId: id[p.key], date, mode: m.mode, agenda: m.agenda,
        participants: m.with.map((k) => ({ id: id[k], name: nameOf(k) })),
        startedAt, endedAt, durationSec: seconds(startedAt, endedAt), presenceSessionId: presenceId,
        approvalStatus: status, ...routeOf(p.key),
        decidedById: m.decision ? deciderId(m.decision.by) : null, decidedAt: m.decision?.at ?? null, decisionNote: m.decision?.note ?? null,
        dueAt: new Date(endedAt.getTime() + 48 * 3600_000), createdAt: endedAt,
      });
      if (status === 'PENDING') pendingRefs.push({ type: 'meeting', id: recId, key: p.key, decider: managerOf(p.key) ?? 'sa' });
      const inside = W.reduce((s, w) => s + overlap(iv, w), 0);
      parts.meetingSec += inside;
      if (status === 'REJECTED') parts.rejectedMinusSec += inside;
      if (status === 'PENDING') parts.pendingMinusSec += inside;
    }

    // One activity sample a minute while working: none on breaks, idle after the first
    // 10 minutes of a quiet hour.
    const tick = 60_000;
    const quietSpans = pl.quiet.map((h) => ({ start: at(date, h * 60 + 10).getTime(), end: at(date, h * 60 + 60).getTime() }));
    for (const w of W) {
      for (let t = w.start; t + tick <= w.end; t += tick) {
        if (away.some((a) => t >= a.start && t < a.end)) continue;
        const quiet = quietSpans.some((q) => t >= q.start && t < q.end);
        const [app, url] = apps[Math.floor(t / (17 * tick)) % apps.length];
        rows.samples.push({ userId: id[p.key], date: calendarOf(t), at: new Date(t), durationSec: 60, idle: quiet, locked: false, app, url });
      }
    }

    const spanSec = W.reduce((s, w) => s + (w.end - w.start) / 1000, 0);
    const focusSec = Math.max(0, spanSec - parts.breakSec + parts.approvedPlusSec - parts.rejectedMinusSec);
    const workday = isoWeekday(date) !== 7;
    const dayClass = !workday ? 'EXTRA' : focusSec >= 0.8 * EXPECTED_SEC ? 'FULL' : focusSec >= 0.4 * EXPECTED_SEC ? 'HALF' : 'ABSENT';
    const lateMin = Math.floor((work[0].start.getTime() - at(date, shiftStartOf(p.key)).getTime()) / 60_000);
    expected[`${p.key}|${date}`] = { ...parts, focusSec, dayClass, lateStart: workday && lateMin > 10 ? lateMin : null };
  }
}

console.log('\n# Writing September');
await db.workSession.createMany({ data: rows.sessions });
await db.workDayEnd.createMany({ data: rows.dayEnds });
await db.presenceSession.createMany({ data: rows.presence });
await db.breakRecord.createMany({ data: rows.breaks });
await db.meetingRecord.createMany({ data: rows.meetings });
for (let i = 0; i < rows.samples.length; i += 5000) {
  await db.activitySample.createMany({ data: rows.samples.slice(i, i + 5000) });
}
check(
  `wrote ${rows.sessions.length} sessions, ${rows.breaks.length} breaks, ${rows.meetings.length} meetings, ${rows.samples.length} samples`,
  rows.sessions.length > 250 && rows.samples.length > 100_000,
  null,
);

// ---------------------------------------------------------------------------------------
const arjun = await new Actor('arjun').login(emailOf(MANAGERS[0]), PASSWORD);
const kavya = await new Actor('kavya').login(emailOf(MANAGERS[1]), PASSWORD);
const priya = await new Actor('priya').login(emailOf(STAFF[0]), PASSWORD);
const teamOf = (m) => STAFF.filter((s) => s.manager === m).map((s) => id[s.key]);

console.log('\n# Scope');
let r = expectStatus('Arjun: people', await arjun.get('/reports/people'), 200);
check('his five, not himself, not Kavya\'s team', data(r)?.items?.length === 5 && data(r).items.every((x) => teamOf('arjun').includes(x.id)), data(r)?.items?.map((x) => x.name));
expectStatus('Arjun: a day of Kavya\'s staff', await arjun.get(`/reports/person/${id.aditya}/day?date=2026-09-10`), 403);
expectStatus('Arjun: Kavya\'s team month', await arjun.get(`/reports/team/month?month=${MONTH}&managerId=${id.kavya}`), 403);
expectStatus('Kavya: Arjun as a person', await kavya.get(`/reports/person/${id.arjun}/month?month=${MONTH}`), 403);
expectStatus('staff cannot open reports', await priya.get('/reports/people'), 403);
r = expectStatus('Super Admin: people', await sa.get('/reports/people'), 200);
check('everyone, both managers included', PEOPLE.every((p) => data(r)?.items?.some((x) => x.id === id[p.key])), data(r)?.items?.length);

console.log('\n# Focus follows the formula (sampled days)');
const special = [
  ['priya', '2026-09-03'], ['rahul', '2026-09-04'], ['deepa', '2026-09-09'], ['aditya', '2026-09-10'],
  ['meera', '2026-09-10'], ['imran', '2026-09-11'], ['pooja', '2026-09-11'], ['rahul', '2026-09-13'],
  ['rohan', '2026-09-14'], ['kavya', '2026-09-15'], ['meera', '2026-09-16'], ['ananya', '2026-09-17'],
  ['vikram', '2026-09-18'], ['rahul', '2026-09-22'], ['pooja', '2026-09-23'], ['aditya', '2026-09-24'],
  ['deepa', '2026-09-25'], ['rohan', '2026-09-29'], ['arjun', '2026-09-29'], ['priya', '2026-09-30'],
  ['imran', '2026-09-30'], ['vikram', '2026-09-02'], ['ananya', '2026-09-07'],
  ['farah', '2026-09-14'], ['farah', '2026-09-16'], ['farah', '2026-09-17'], ['farah', '2026-09-21'], ['farah', '2026-09-30'],
];
const sampled = [...special];
for (let i = 0; i < 8; i++) {
  const p = PEOPLE[jitter(0, PEOPLE.length - 1)];
  const date = DATES[jitter(0, DATES.length - 1)];
  if (plan[p.key][date]) sampled.push([p.key, date]);
}
for (const [key, date] of sampled) {
  r = await sa.get(`/reports/person/${id[key]}/day?date=${date}`);
  const s = data(r)?.summary;
  const e = expected[`${key}|${date}`];
  const same = s && ['focusSec', 'breakSec', 'meetingSec', 'approvedPlusSec', 'rejectedMinusSec', 'pendingPlusSec', 'pendingMinusSec'].every((k) => s[k] === e[k]);
  check(
    `${nameOf(key)} ${date}: focus ${e.focusSec} s, ${e.dayClass}${e.lateStart ? `, ${e.lateStart} min late` : ''}`,
    r.status === 200 && same && s.dayClass === e.dayClass && (s.lateStart?.minutes ?? null) === e.lateStart,
    { got: s, want: e },
  );
}

console.log('\n# Day classes at the boundaries and the special days');
const months = {};
for (const p of PEOPLE) {
  r = await sa.get(`/reports/person/${id[p.key]}/month?month=${MONTH}`);
  months[p.key] = data(r);
}
const classOn = (key, date) => months[key]?.days?.find((x) => x.date === date)?.dayClass;
check('exactly 80% of expected is FULL', classOn('priya', '2026-09-24') === 'FULL', months.priya?.days?.[23]);
check('one second less is HALF', classOn('rahul', '2026-09-24') === 'HALF', months.rahul?.days?.[23]);
check('exactly 40% is HALF', classOn('deepa', '2026-09-24') === 'HALF', months.deepa?.days?.[23]);
check('one second less is ABSENT', classOn('vikram', '2026-09-24') === 'ABSENT', months.vikram?.days?.[23]);
check('no work on a workday is ABSENT', classOn('vikram', '2026-09-08') === 'ABSENT' && classOn('pooja', '2026-09-15') === 'ABSENT');
check('a Sunday worked is EXTRA, others OFF', classOn('rahul', '2026-09-13') === 'EXTRA' && classOn('priya', '2026-09-13') === 'OFF');
check('the missed End Day was closed automatically', months.rohan?.days?.find((x) => x.date === '2026-09-14')?.autoClosed === true);
check('late starts counted', months.vikram?.totals?.lateStarts === 1 && months.rohan?.totals?.lateStarts === 1 && months.ananya?.totals?.lateStarts === 1, [months.vikram?.totals?.lateStarts, months.rohan?.totals?.lateStarts]);
check('Imran: five quiet hours, needs a look', months.imran?.totals?.quietHours === 5 && months.imran.totals.needsALook === true, months.imran?.totals);
check('Pooja: two quiet hours, no flag', months.pooja?.totals?.quietHours === 2 && months.pooja.totals.needsALook === false, months.pooja?.totals);
check('the heatmap shows the quiet hour', months.imran?.heatmap?.find((h) => h.date === '2026-09-07')?.hours?.[14] === 10, months.imran?.heatmap?.[6]?.hours);
r = await sa.get(`/reports/person/${id.meera}/day?date=2026-09-10`);
check('the resumed day shows the gap', data(r)?.timeline?.some((s) => s.kind === 'OFF'), data(r)?.timeline?.map((s) => s.kind));

console.log('\n# The night shift (18:30 to 03:30)');
const night = months.farah;
const nightsWorked = DATES.filter((d) => plan.farah[d]).length;
check(`every night is one working day, dated the evening it began (${nightsWorked} nights, all FULL)`,
  night?.totals?.workdays === nightsWorked && night.totals.full === nightsWorked && night.totals.absent === 0 && night.totals.off === 30 - nightsWorked,
  night?.totals);
const nightDayOf = (date) => night?.days?.find((x) => x.date === date);
check('the missed End Day closed itself at 02:10', nightDayOf('2026-09-21')?.autoClosed === true && nightDayOf('2026-09-21')?.dayClass === 'FULL', nightDayOf('2026-09-21'));
check('one late start, 22 minutes after 18:30', night?.totals?.lateStarts === 1 && nightDayOf('2026-09-17')?.lateStart?.minutes === 22, nightDayOf('2026-09-17')?.lateStart);
r = expectStatus('Farah, 16 September', await sa.get(`/reports/person/${id.farah}/day?date=2026-09-16`), 200);
check('the 00:40 meeting belongs to the evening it began', data(r)?.meetings?.length === 1 && data(r).meetings[0].date === '2026-09-16' && data(r).summary.meetingSec === 1800, data(r)?.meetings);
check('the timeline runs past midnight', data(r)?.timeline?.at(-1)?.endedAt > wallToUtc('2026-09-17', '03:00').toISOString(), data(r)?.timeline?.at(-1));
const heat = (date) => night?.heatmap?.find((h) => h.date === date)?.hours ?? [];
check('the hours after midnight are on the evening\'s heatmap row', heat('2026-09-15')[1] > 40 && heat('2026-09-15')[20] > 40 && heat('2026-09-15')[10] === 0, heat('2026-09-15'));
check('a Sunday night off, and Monday night\'s early hours on Monday', heat('2026-09-13').every((m) => m === 0) && heat('2026-09-14')[2] > 40, [heat('2026-09-13'), heat('2026-09-14')]);
check('the last night (into 1 October) counts in September', nightDayOf('2026-09-30')?.dayClass === 'FULL' && heat('2026-09-30')[2] > 40, nightDayOf('2026-09-30'));
r = expectStatus('Team on 16 September (Super Admin)', await sa.get('/team/today?date=2026-09-16'), 200);
const farahRow = data(r)?.rows?.find((x) => x.user.id === id.farah);
check('Team on a past day: Farah\'s night, ended', farahRow?.date === '2026-09-16' && farahRow.status === 'DAY_ENDED' && farahRow.focus.focusSec === nightDayOf('2026-09-16')?.focusSec, farahRow);

console.log('\n# Month totals are the sum of the days');
const SUMS = ['focusSec', 'expectedSec', 'skipped', 'autoSkipped', 'overruns', 'meetings', 'approvedPlusSec', 'rejectedMinusSec', 'pending', 'quietHours'];
for (const p of PEOPLE) {
  const m = months[p.key];
  const days = m?.days ?? [];
  const by = (c) => days.filter((x) => x.dayClass === c).length;
  const ok =
    days.length === 30 &&
    SUMS.every((k) => m.totals[k] === days.reduce((s, x) => s + x[k], 0)) &&
    m.totals.full === by('FULL') && m.totals.half === by('HALF') && m.totals.absent === by('ABSENT') &&
    m.totals.off === by('OFF') && m.totals.extra === by('EXTRA') &&
    m.totals.workdays === days.filter((x) => x.workday).length &&
    m.totals.lateStarts === days.filter((x) => x.lateStart).length;
  const focus = DATES.reduce((s, d) => s + (expected[`${p.key}|${d}`]?.focusSec ?? 0), 0);
  check(`${nameOf(p.key)}: totals add up, focus ${Math.round(focus / 36) / 100} h as computed here`, ok && m.totals.focusSec === focus, m?.totals);
}

console.log('\n# Team totals are the sum of the rows');
const teams = {};
for (const [label, who, query] of [['Arjun', arjun, ''], ['Kavya', kavya, ''], ['everyone', sa, '']]) {
  r = await who.get(`/reports/team/month?month=${MONTH}${query}`);
  const t = data(r);
  teams[label] = t;
  const keys = ['workdays', 'full', 'half', 'absent', 'off', 'extra', 'lateStarts', ...SUMS];
  check(
    `${label}: ${t?.rows?.length} rows, totals add up`,
    r.status === 200 && t.totals.people === t.rows.length && keys.every((k) => t.totals[k] === t.rows.reduce((s, x) => s + x.totals[k], 0)) && t.totals.needsALook === t.rows.some((x) => x.totals.needsALook),
    t?.totals,
  );
}
check('a manager\'s report is TEAM, the Super Admin\'s ALL', teams.Arjun?.scope === 'TEAM' && teams.Arjun.rows.length === 5 && teams.Kavya?.rows?.length === 5 && teams.everyone?.scope === 'ALL');

console.log('\n# Excel export');
r = await sa.get(`/reports/team/month/export.xlsx?month=${MONTH}&managerId=${id.kavya}`);
check('downloads as rx-vision-2026-09-team.xlsx', r.status === 200 && r.headers?.['content-disposition'] === 'attachment; filename="rx-vision-2026-09-team.xlsx"', r.headers);
if (r.file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.file);
  const payroll = wb.getWorksheet('Payroll');
  const daysSheet = wb.getWorksheet('Days');
  check('Payroll: header and five rows; Days: five people x 30 days', payroll?.rowCount === 6 && daysSheet?.rowCount === 151, [payroll?.rowCount, daysSheet?.rowCount]);
  check('frozen bold header', payroll?.views?.[0]?.state === 'frozen' && payroll?.getRow(1)?.font?.bold === true);
  let matches = 0;
  for (let i = 2; i <= (payroll?.rowCount ?? 0); i++) {
    const row = payroll.getRow(i);
    const m = Object.values(months).find((x) => x?.person?.email === row.getCell(2).value);
    if (m && row.getCell(10).value === Math.round((m.totals.focusSec / 3600) * 100) / 100 && row.getCell(5).value === m.totals.workdays && row.getCell(15).value === m.totals.autoSkipped) matches++;
  }
  check('each row matches the report (focus hours, workdays, auto-skips)', matches === 5, matches);
}

console.log('\n# Month lock');
r = await sa.post(`/reports/months/${MONTH}/lock`, {});
check(`refused while ${pendingRefs.length} items wait [409 PENDING_APPROVALS]`, r.status === 409 && r.body?.error?.code === 'PENDING_APPROVALS' && r.body.error.details.count === pendingRefs.length, r.body);
const actorFor = { arjun, kavya, sa };
for (const ref of pendingRefs) {
  r = await actorFor[ref.decider].post(`/approvals/${ref.type}/${ref.id}/approve`, { note: 'Approved before payroll' });
  check(`${ref.decider === 'sa' ? 'Super Admin' : nameOf(ref.decider)} approves ${nameOf(ref.key)}'s ${ref.type}`, r.status === 200 && data(r)?.status === 'APPROVED', r.body);
}
const before = data(await sa.get(`/reports/team/month?month=${MONTH}`));
r = expectStatus('Super Admin locks September', await sa.post(`/reports/months/${MONTH}/lock`, {}), 200);
check('locked, nothing pending', data(r)?.locked === true && data(r)?.pending === 0, data(r));
r = await sa.get(`/reports/team/month?month=${MONTH}`);
check('team month is served from the snapshot, same numbers', data(r)?.locked === true && JSON.stringify(data(r)?.totals) === JSON.stringify(before?.totals), { before: before?.totals, after: data(r)?.totals });
r = await arjun.get(`/reports/person/${id.priya}/month?month=${MONTH}`);
check('person month too', data(r)?.locked === true && data(r)?.totals?.focusSec === months.priya?.totals?.focusSec, data(r)?.totals);
const ref0 = pendingRefs.find((x) => x.decider === 'arjun');
r = await arjun.post(`/approvals/${ref0.type}/${ref0.id}/reopen`, {});
check('decisions are refused while locked [409 MONTH_LOCKED]', r.status === 409 && r.body?.error?.code === 'MONTH_LOCKED', r.body);
r = expectStatus('Super Admin unlocks', await sa.del(`/reports/months/${MONTH}/lock`), 200);
check('unlocked', data(r)?.locked === false, data(r));
// Put the waiting items back as they were, for screenshots of Approvals.
for (const ref of pendingRefs) {
  r = await actorFor[ref.decider].post(`/approvals/${ref.type}/${ref.id}/reopen`, {});
  check(`${nameOf(ref.key)}'s ${ref.type} waits again`, r.status === 200 && data(r)?.status === 'PENDING', r.body);
}

console.log('\n# Monthly report runs (as the 1 October job leaves them)');
const generatedAt = wallToUtc('2026-10-01', '00:30');
const runSummary = (list) => ({
  people: list.length,
  ...Object.fromEntries(['workdays', 'full', 'half', 'absent', 'extra', 'focusSec', 'expectedSec', 'lateStarts', 'pending', 'quietHours'].map((k) => [k, list.reduce((s, x) => s + x.totals[k], 0)])),
  needsALook: list.filter((x) => x.totals.needsALook).length,
});
const everyone = data(await sa.get(`/reports/team/month?month=${MONTH}`));
const owners = (data(await sa.get('/reports/people'))?.items ?? []).filter((x) => x.role === 'MANAGER' || x.role === 'SUPER_ADMIN');
for (const o of owners) {
  const scope = o.role === 'SUPER_ADMIN' ? 'ALL' : 'TEAM';
  const list = scope === 'ALL' ? everyone.rows : everyone.rows.filter((x) => x.person.managerId === o.id);
  await db.reportRun.upsert({
    where: { month_scope_ownerId: { month: MONTH, scope, ownerId: o.id } },
    create: { month: MONTH, scope, ownerId: o.id, generatedAt, summary: runSummary(list) },
    update: { generatedAt, summary: runSummary(list) },
  });
}
r = expectStatus('Arjun\'s runs', await arjun.get('/reports/runs'), 200);
check('September for his team', data(r)?.items?.some((x) => x.month === MONTH && x.scope === 'TEAM' && x.summary.people === 5), data(r)?.items);

// ---------------------------------------------------------------------------------------
const hours = (sec) => (sec / 3600).toFixed(1);
console.log('\n# September 2026 is in place');
for (const [label, t] of [['Arjun Mehta (Billing, AR Calling)', teams.Arjun], ['Kavya Menon (Coding, QA)', teams.Kavya]]) {
  console.log(`  ${label}: ${t.rows.length} people, ${hours(t.totals.focusSec)} h focus of ${hours(t.totals.expectedSec)} h expected, ` +
    `${t.totals.full} full, ${t.totals.half} half, ${t.totals.absent} absent days, late starts: ${t.totals.lateStarts}`);
}
console.log(`  ${rows.sessions.length} work sessions, ${rows.breaks.length} break records, ${rows.meetings.length} meetings, ` +
  `${rows.samples.length} activity samples; ${pendingRefs.length} items waiting for a decision`);
console.log(`  Sign in as ${PEOPLE.map(emailOf).slice(0, 3).join(', ')}, ... with the password ${PASSWORD}`);

await db.$disconnect();
summary();
