// 4.0 integrity checks from the audit: offline replay cannot invent working time
// (a forged day has no focus), a replayed day with the agent's activity counts,
// X-Event-At is honoured only on agent actions from a 4.0 agent, and a replayed
// action that fails leaves an auto-closed day closed. Also: the week pattern is
// effective from a date and never rewrites a locked month, shift names are unique
// per organisation under a race, and a deleted organisation takes no new people.
// Second audit round: a day cut into 2-minute replayed sessions has no focus (H1),
// a backlog that arrives while today's day is open is stored (H2), one late sample
// does not make an auto-closed day focus (M5), a refused End Day leaves nothing
// (M1), a replay past the latest end changes and announces nothing (M2), replayed
// presence and away keep their day and the SLA starts on receipt (M3, L2), an End
// Day older than the open day is refused (L3), what managers see per grant (M4,
// L4, L1), departments of other organisations (L5) and locked months.
// Self-contained on a seeded database (it creates its own people with a run suffix).
// Reads the database (DATABASE_URL, local only) for what no API shows.
import { randomUUID } from 'node:crypto';
import { AGENT_40_UA, check, Client, expectStatus, summary, todayKey } from './lib.mjs';
import { openDb, wallToUtc } from './db.mjs';

const data = (r) => r.body?.data;
const RUN = Date.now().toString(36);
const PASS = 'Integrity#2026x';
const near = (a, b, tol = 60) => typeof a === 'number' && Math.abs(a - b) <= tol;
function expectError(label, r, status, code) {
  check(
    `${label} [${status}${code ? ' ' + code : ''}]`,
    r.status === status && (!code || r.body?.error?.code === code),
    {
      got: r.status,
      body: r.body,
    },
  );
  return r;
}

const db = await openDb();
const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
const admin = await new Client('orgadmin').login('orgadmin@timechamp.test', 'orgadmin123');
const departments = data(await admin.get('/departments')) ?? [];
check('the organisation has a department', departments.length > 0, departments);

let n = 0;
/** A fresh Staff member of the seeded organisation, signed in with `ua`. */
async function staff(label, ua = AGENT_40_UA) {
  n += 1;
  const email = `integrity.${n}.${RUN}@timechamp.test`;
  const r = await admin.post('/users', {
    firstName: 'Integrity',
    lastName: `${label} ${RUN}`,
    email,
    password: PASS,
    role: 'USER',
    departmentId: departments[0]?.id,
  });
  check(`Staff for ${label} created [201]`, r.status === 201, r.body);
  const c = await new Client(label, ua).login(email, PASS);
  c.id = c.user?.id;
  return c;
}
const replay = (c, path, at, body = {}) =>
  c.req('POST', path, body, { 'x-client-event-id': randomUUID(), 'x-event-at': at.toISOString() });
const timesheetDay = async (who, date) =>
  data(await admin.get(`/reports/person/${who.id}/timesheet?from=${date}&to=${date}`))?.rows?.[0];

console.log('\n# A forged day: replayed Start and End Day with no activity');
const forger = await staff('forged day');
const d3 = todayKey(-3);
const forgedStart = wallToUtc(d3, '09:00');
let r = await replay(forger, '/activity/start-day', forgedStart);
check('replayed Start Day 3 days ago [200]', r.status === 200, r.body);
const forgedEnd = new Date(forgedStart.getTime() + 9 * 3_600_000);
r = await replay(forger, '/activity/end-day', forgedEnd);
if (r.status === 409 && r.body?.error?.code === 'SKIP_COMMENTS_REQUIRED') {
  // The day's breaks were skipped: End Day carries a comment for each (as the agent does).
  const comments = (r.body.error.details?.breaks ?? []).map((b) => ({
    breakId: b.id,
    comment: 'Busy with the month-end release',
  }));
  r = await replay(forger, '/activity/end-day', forgedEnd, { comments });
}
check('replayed End Day 9 hours later [200]', r.status === 200, r.body);
let row = await timesheetDay(forger, d3);
check(
  'the day exists with its 9 hours',
  row?.in && row?.out && near(new Date(row.out) - new Date(row.in), 9 * 3_600_000, 1000),
  row,
);
check(
  'no focus, no pay: all of it offline with no activity data',
  row?.focusSec === 0 && row?.paidSec === 0 && near(row?.unverifiedSec, 9 * 3600),
  row,
);
const forgedHistory = data(await forger.get(`/workday/me/history?month=${d3.slice(0, 7)}`));
const fh = forgedHistory?.days?.find((d) => d.date === d3);
check(
  'the person sees it in History too',
  fh?.focusSec === 0 && near(fh?.unverifiedSec, 9 * 3600),
  fh,
);
r = await admin.get(`/reports/person/${forger.id}/timesheet.xlsx?from=${d3}&to=${d3}`);
check('the timesheet Excel downloads', r.status === 200 && r.file?.length > 1000, {
  status: r.status,
});

console.log('\n# A day worked offline, with the activity the agent queued');
const worker = await staff('covered day');
const d2 = todayKey(-2);
const workStart = wallToUtc(d2, '09:00');
const minute = (m) => new Date(workStart.getTime() + m * 60_000);
check(
  'replayed Start Day 2 days ago [200]',
  (await replay(worker, '/activity/start-day', minute(0))).status === 200,
);
check(
  'replayed End Day 2 hours later [200]',
  (await replay(worker, '/activity/end-day', minute(120))).status === 200,
);
// After the journal, as the agent does: one sample every two minutes, a few idle or locked.
let stored = 0;
for (let m = 0; m < 120; m += m < 118 ? 2 : 1) {
  const res = await worker.post('/activity/report', {
    at: minute(m).toISOString(),
    app: m >= 60 && m < 66 ? 'LockApp.exe' : 'Excel.exe',
    idle: m >= 40 && m < 50,
    locked: m >= 60 && m < 66,
  });
  if (res.status === 200) stored += 1;
}
check('every queued sample was taken', stored === 61, { stored });
row = await timesheetDay(worker, d2);
check(
  'it counts as focus like a live day',
  near(row?.focusSec, 2 * 3600) && row?.unverifiedSec <= 60,
  row,
);
check('paid time = focus + paid breaks', row?.paidSec === row?.focusSec + row?.paidBreakSec, row);
const samples = await db.activitySample.count({
  where: { userId: worker.id, at: { gte: minute(0), lt: minute(120) } },
});
check('the samples taken before the replayed End Day are stored', samples === 61, { samples });

console.log('\n# X-Event-At only on agent actions from a 4.0 agent');
const asker = await staff('approval');
expectStatus('Start Day (live)', await asker.post('/activity/start-day', {}), 200);
r = await asker.post('/away', {
  startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  reasonKey: 'THINKING',
  comment: 'Working through the design',
});
const awayId = data(r)?.away?.id;
check('an away answer waits for a decision', data(r)?.away?.status === 'PENDING', data(r));
const decisionEvent = randomUUID();
const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
r = await admin.post(
  `/approvals/away/${awayId}/approve`,
  { note: 'ok' },
  { 'x-client-event-id': decisionEvent, 'x-event-at': sixDaysAgo },
);
check(
  'a decision sent with X-Event-At 6 days ago is taken now',
  r.status === 200 && Math.abs(new Date(data(r)?.decidedAt) - Date.now()) < 120_000,
  data(r),
);
const repeat = await admin.post(
  `/approvals/away/${awayId}/approve`,
  { note: 'ok' },
  { 'x-client-event-id': decisionEvent, 'x-event-at': sixDaysAgo },
);
check(
  'the same event id again answers the stored result',
  repeat.status === 200 && data(repeat)?.decidedAt === data(r)?.decidedAt,
  repeat.body,
);
const curl = await staff('curl', 'curl/8.5.0');
r = await replay(curl, '/activity/start-day', new Date(Date.now() - 3 * 3_600_000));
check(
  'Start Day "replayed" by a client that is not a 4.0 agent runs at the server time',
  r.status === 200 && Math.abs(new Date(data(r)?.workday?.startedAt) - Date.now()) < 120_000,
  data(r)?.workday,
);
await curl.post('/activity/end-day', {});

console.log('\n# A failed replayed action leaves an auto-closed day closed');
const late = await staff('auto-closed');
const d1 = todayKey(-2);
const s0 = wallToUtc(d1, '09:00');
const t = (m) => new Date(s0.getTime() + m * 60_000);
check('replayed Start Day [200]', (await replay(late, '/activity/start-day', t(0))).status === 200);
for (let m = 0; m <= 60; m += 2)
  await late.post('/activity/report', { at: t(m).toISOString(), app: 'Excel.exe' });
await late.get('/workday/me/today'); // the missed End Day is closed now, at the last input
const closed = await db.workSession.findFirst({
  where: { userId: late.id },
  orderBy: { startedAt: 'desc' },
});
check(
  'the day was auto-closed at the last input',
  closed?.endReason === 'AUTO_CLOSED' && near(closed.endedAt - t(60), 0, 1000),
  closed,
);
r = await replay(late, '/breaks/skip', new Date(closed.endedAt.getTime() + 30 * 60_000));
check('a replayed skip with no kind is refused [400]', r.status === 400, r.body);
const after = await db.workSession.findUnique({ where: { id: closed.id } });
check(
  'the session is still closed exactly as it was',
  after?.endedAt?.getTime() === closed.endedAt.getTime() &&
    after?.endReason === 'AUTO_CLOSED' &&
    after?.source === closed.source,
  after,
);
const dayEnd = await db.workDayEnd.findUnique({
  where: { userId_date: { userId: late.id, date: closed.date } },
});
check('and the day keeps its End Day mark', !!dayEnd?.endedAt, dayEnd);
r = await replay(late, '/activity/end-day', new Date(closed.endedAt.getTime() + 40 * 60_000));
check('a replayed End Day after the close succeeds [200]', r.status === 200, r.body);
const ended = await db.workSession.findUnique({ where: { id: closed.id } });
check(
  'it reopened the day as a REPLAY session and ended it at the replayed time',
  ended?.endReason === 'USER' &&
    ended?.source === 'REPLAY' &&
    ended?.endedAt?.getTime() === closed.endedAt.getTime() + 40 * 60_000,
  ended,
);

console.log('\n# The week pattern is effective from a date; a locked month keeps its days');
const me = data(await admin.get('/me'));
const orgId = me?.organisation?.id;
const today = todayKey();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const calendar = async (year) => data(await admin.get(`/calendar?year=${year}`));
const workingDays = (cal, month) => cal?.months?.find((m) => m.month === month)?.workingDays;
const lockedMonth = todayKey(-62).slice(0, 7);
const nextYear = Number(today.slice(0, 4)) + 1;
const cal0 = await calendar(today.slice(0, 4));
const lockedYear0 = await calendar(lockedMonth.slice(0, 4));
const next0 = await calendar(nextYear);
const old = cal0?.weekPattern ?? [];
check(
  'GET /calendar carries the pattern history',
  Array.isArray(cal0?.weekPatternHistory) && same(cal0.weekPatternHistory.at(-1)?.days, old),
  cal0?.weekPatternHistory,
);
const fresh = old.includes(6) ? old.filter((d) => d !== 6) : [...old, 6].sort((a, b) => a - b);

// Lock a past month: through the API, or straight in the database when the API
// cannot lock it (a month before the first working day on record is out of range).
const lockKey = { companyId_month: { companyId: orgId, month: lockedMonth } };
let unlockWith = null;
if (!(await db.monthLock.findUnique({ where: lockKey }))) {
  r = await admin.post(`/reports/months/${lockedMonth}/lock`, {});
  if (r.status === 200) unlockWith = 'api';
  else {
    await db.monthLock.create({
      data: { companyId: orgId, month: lockedMonth, lockedById: me.id, snapshot: {} },
    });
    unlockWith = 'db';
  }
}
check(
  `${lockedMonth} is locked (${unlockWith ?? 'already'})`,
  !!(await db.monthLock.findUnique({ where: lockKey })),
);
expectError(
  'a pattern from a date in a locked month',
  await admin.put('/calendar/week-pattern', { days: fresh, from: `${lockedMonth}-10` }),
  409,
  'MONTH_LOCKED',
);
expectError(
  'a pattern from a date before a locked month',
  await admin.put('/calendar/week-pattern', {
    days: fresh,
    from: `${todayKey(-93).slice(0, 7)}-10`,
  }),
  409,
  'MONTH_LOCKED',
);
expectError(
  'a malformed from',
  await admin.put('/calendar/week-pattern', { days: fresh, from: '19-10-2026' }),
  400,
);

r = expectStatus(
  'a new pattern from today',
  await admin.put('/calendar/week-pattern', { days: fresh }),
  200,
);
let view = data(r);
check('today has the new pattern', same(view?.weekPattern, fresh), view?.weekPattern);
const hist = view?.weekPatternHistory ?? [];
const entry = (e, from, days) => e?.from === from && same(e?.days, days);
check(
  'the history: the old pattern until yesterday, the new one from today',
  entry(hist.at(-1), today, fresh) && same(hist.at(-2)?.days, old),
  hist,
);
const lockedYear1 = await calendar(lockedMonth.slice(0, 4));
check(
  'the locked month keeps its working days',
  workingDays(lockedYear1, lockedMonth) === workingDays(lockedYear0, lockedMonth),
  { before: workingDays(lockedYear0, lockedMonth), after: workingDays(lockedYear1, lockedMonth) },
);
const next1 = await calendar(nextYear);
check(
  'next January follows the new pattern',
  workingDays(next1, `${nextYear}-01`) !== workingDays(next0, `${nextYear}-01`),
  { before: workingDays(next0, `${nextYear}-01`), after: workingDays(next1, `${nextYear}-01`) },
);

const later = todayKey(40);
r = expectStatus(
  'a pattern from a later date',
  await admin.put('/calendar/week-pattern', { days: old, from: later }),
  200,
);
view = data(r);
check(
  'today still has the current one; the later one is in the history',
  same(view?.weekPattern, fresh) && entry(view?.weekPatternHistory?.at(-1), later, old),
  view?.weekPatternHistory,
);
r = expectStatus(
  'back to the old pattern from today',
  await admin.put('/calendar/week-pattern', { days: old }),
  200,
);
check(
  'the old pattern again: the later entry gone, no duplicate entry for the same week',
  same(data(r)?.weekPattern, old) &&
    same(data(r)?.weekPatternHistory?.at(-1)?.days, old) &&
    !(data(r)?.weekPatternHistory ?? []).some((e) => e.from >= today),
  data(r)?.weekPatternHistory,
);
if (unlockWith === 'api')
  expectStatus(
    'unlock the month again',
    await admin.del(`/reports/months/${lockedMonth}/lock`),
    200,
  );
if (unlockWith === 'db') await db.monthLock.delete({ where: lockKey });

console.log('\n# Shift names stay unique under a race');
const shiftDef = (name) => ({
  name,
  start: '09:00',
  end: '18:00',
  workDays: [1, 2, 3, 4, 5],
  ringLeadMin: 1,
  ringDurationMin: 5,
  reasonOnEarly: true,
  reasonOnLate: true,
  reasonMinChars: 10,
  overrunReason: true,
  overrunGraceMin: 0,
  breaks: [
    {
      kind: 'MORNING',
      enabled: true,
      startTime: '11:00',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'LUNCH',
      enabled: true,
      startTime: '13:30',
      durationMin: 30,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
    {
      kind: 'EVENING',
      enabled: true,
      startTime: '16:30',
      durationMin: 15,
      windowBeforeMin: 30,
      windowAfterMin: 60,
    },
  ],
});
const raced = await Promise.all(
  Array.from({ length: 6 }, () => admin.post('/shifts', shiftDef(`Race ${RUN}`))),
);
const codes = raced.map((x) => x.status).sort();
check(
  'six parallel creates with one name: exactly one 201, five 409',
  same(codes, [201, 409, 409, 409, 409, 409]),
  codes,
);
const shifts = data(await admin.get('/shifts')) ?? [];
const shiftList = Array.isArray(shifts) ? shifts : (shifts.items ?? []);
check(
  'one shift by that name',
  shiftList.filter((s) => s.name.toLowerCase() === `race ${RUN}`.toLowerCase()).length === 1,
  shiftList.map((s) => s.name),
);
const sa1 = data(await admin.post('/shifts', shiftDef(`Race A ${RUN}`)));
const sb1 = data(await admin.post('/shifts', shiftDef(`Race B ${RUN}`)));
const renames = await Promise.all([
  admin.put(`/shifts/${sa1?.id}`, shiftDef(`Race C ${RUN}`)),
  admin.put(`/shifts/${sb1?.id}`, shiftDef(`race c ${RUN}`)),
]);
check(
  'two parallel renames to one name: one 200, one 409',
  same(renames.map((x) => x.status).sort(), [200, 409]),
  renames.map((x) => [x.status, x.body?.error?.code]),
);
for (const s of [raced.find((x) => x.status === 201)?.body?.data, sa1, sb1])
  if (s?.id) await admin.del(`/shifts/${s.id}`);

console.log('\n# A deleted organisation takes nobody new');
const icons = data(await admin.get('/departments/icons'));
const icon = Array.isArray(icons) ? (icons[0]?.key ?? icons[0]) : undefined;
const inOrg = async (id) => {
  const c = await new Client('superadmin in org').login('admin@timechamp.test', 'admin123');
  c.headers['x-org-id'] = id;
  return c;
};
const liveIn = async (id) => ({
  people: await db.user.count({ where: { companyId: id, deletedAt: null } }),
  departments: await db.department.count({ where: { companyId: id, deletedAt: null } }),
});
let both = 0;
const orderings = new Set();
for (let i = 0; i < 4; i += 1) {
  const org = data(await sa.post('/organisations', { name: `Integrity C${i} ${RUN}` }))?.id;
  const saC = await inOrg(org);
  expectStatus(
    `organisation C${i}: a department first`,
    await saC.post('/departments', { name: 'Ops', icon }),
    201,
  );
  const deptC = data(await saC.get('/departments'))?.[0]?.id;
  const adds = () => [
    sa.post(`/organisations/${org}/admin`, {
      firstName: 'Race',
      lastName: 'Admin',
      email: `admin.c${i}.${RUN}@integrity.test`,
      password: PASS,
    }),
    saC.post('/users', {
      firstName: 'Race',
      lastName: 'Staff',
      email: `staff.c${i}.${RUN}@integrity.test`,
      password: PASS,
      role: 'USER',
      departmentId: deptC,
    }),
    saC.post('/departments', { name: `Late ${i}`, icon }),
  ];
  // Even rounds send the delete first; odd rounds the additions, ahead by a little
  // (round 1) or by about the time a password hash takes (round 3).
  let del;
  let added;
  if (i % 2 === 0) {
    const d = sa.del(`/organisations/${org}`);
    added = await Promise.all(adds());
    del = await d;
  } else {
    const a = Promise.all(adds());
    await new Promise((res) => setTimeout(res, i === 1 ? 10 : 300));
    del = await sa.del(`/organisations/${org}`);
    added = await a;
  }
  const deleted = (await db.company.findUnique({ where: { id: org } }))?.deletedAt != null;
  orderings.add(deleted ? 'deleted' : 'kept');
  if (deleted) {
    const left = await liveIn(org);
    check(
      `C${i}: deleted, and nothing live is left in it`,
      del.status === 200 && left.people === 0 && left.departments === 0,
      { left, added: added.map((x) => x.status) },
    );
    check(
      `C${i}: every addition after the delete is 404 ORG_NOT_FOUND`,
      added.every(
        (x) =>
          [200, 201].includes(x.status) ||
          (x.status === 404 && x.body?.error?.code === 'ORG_NOT_FOUND'),
      ),
      added.map((x) => [x.status, x.body?.error?.code]),
    );
  } else {
    check(
      `C${i}: an addition came first, so the delete is refused (409 ORG_NOT_EMPTY)`,
      del.status === 409 &&
        del.body?.error?.code === 'ORG_NOT_EMPTY' &&
        added.some((x) => x.status === 201),
      { del: del.status, added: added.map((x) => x.status) },
    );
  }
  if (deleted && added.some((x) => x.status === 201)) both += 1;
}
console.log(
  `  (orderings seen: ${[...orderings].join(', ')}; additions committed before a delete: ${both})`,
);

// After a delete: every write and the Super Admin's X-Org-Id answer 404 ORG_NOT_FOUND.
const gone = data(await sa.post('/organisations', { name: `Integrity gone ${RUN}` }))?.id;
const saGone = await inOrg(gone);
expectStatus('delete an empty organisation', await sa.del(`/organisations/${gone}`), 200);
expectError(
  'its Admin afterwards',
  await sa.post(`/organisations/${gone}/admin`, {
    firstName: 'Late',
    lastName: 'Admin',
    email: `admin.gone.${RUN}@integrity.test`,
    password: PASS,
  }),
  404,
  'ORG_NOT_FOUND',
);
expectError('X-Org-Id of it: the settings', await saGone.get('/settings'), 404, 'ORG_NOT_FOUND');
expectError(
  'X-Org-Id of it: a department',
  await saGone.post('/departments', { name: 'Ops', icon }),
  404,
  'ORG_NOT_FOUND',
);
expectError(
  'X-Org-Id of it: a person',
  await saGone.post('/users', {
    firstName: 'Late',
    lastName: 'Staff',
    email: `staff.gone.${RUN}@integrity.test`,
    password: PASS,
    role: 'MANAGER',
  }),
  404,
  'ORG_NOT_FOUND',
);
expectError(
  'moving someone into it',
  await sa.post(`/organisations/${gone}/people/${forger.id}`, {}),
  404,
);

// ---- Second audit round -------------------------------------------------------------

/** End Day (replayed at `at`, or live), commenting on the skips the gate lists. */
async function endDay(c, at) {
  const send = (body) =>
    at ? replay(c, '/activity/end-day', at, body) : c.post('/activity/end-day', body);
  let res = await send({});
  if (res.status === 409 && res.body?.error?.code === 'SKIP_COMMENTS_REQUIRED') {
    const comments = (res.body.error.details?.breaks ?? []).map((b) => ({
      breakId: b.id,
      comment: 'Busy with the month-end release',
    }));
    res = await send({ comments });
  }
  return res;
}
const y = todayKey(-1);
const minutes = (from, m) => new Date(from.getTime() + m * 60_000);
/** A live day the server auto-closed at its last input: session, End Day mark, a sample a minute. */
async function autoClosedDay(who, date, from, to) {
  const session = await db.workSession.create({
    data: {
      userId: who.id,
      date,
      startedAt: from,
      endedAt: to,
      endReason: 'AUTO_CLOSED',
      source: 'AGENT',
    },
  });
  await db.workDayEnd.create({ data: { userId: who.id, date, endedAt: to, loginAt: from } });
  const count = Math.round((to - from) / 60_000);
  await db.activitySample.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      userId: who.id,
      date,
      at: minutes(from, i),
      durationSec: 60,
      idle: false,
      app: 'Code.exe',
    })),
  });
  return session;
}
const noticesOf = (who) =>
  db.notification.count({ where: { OR: [{ fromUserId: who.id }, { userId: who.id }] } });

console.log('\n# Re-audit H1: a day cut into 2-minute replayed sessions with no samples');
const splitter = await staff('split day');
const d4 = todayKey(-4);
const at0600 = wallToUtc(d4, '06:00');
let pairs = 0;
for (let i = 0; i < 30; i += 1) {
  const s = minutes(at0600, i * 4);
  const a = await replay(splitter, '/activity/start-day', s);
  const b = await endDay(splitter, minutes(s, 2));
  if (a.status === 200 && b.status === 200) pairs += 1;
}
check('30 replayed Start/End pairs of 2 minutes, 2 minutes apart', pairs === 30, pairs);
row = await timesheetDay(splitter, d4);
check(
  'no focus and no pay: the whole hour is offline with no activity data',
  row?.focusSec === 0 && row?.paidSec === 0 && near(row?.unverifiedSec, 3600, 5),
  row,
);

console.log("\n# Re-audit H2: yesterday's samples arrive while today's day is open");
const noEnd = await staff('offline day, no End Day');
const yStart = wallToUtc(y, '09:00');
check(
  'journal: Start Day yesterday 9:00 AM (replayed) [200]',
  (await replay(noEnd, '/activity/start-day', yStart)).status === 200,
);
check(
  'journal: Start Day today (pressed now) [200]',
  (await noEnd.post('/activity/start-day', {})).status === 200,
);
for (let m = 0; m < 100; m += 1) {
  await noEnd.post('/activity/report', {
    at: minutes(yStart, m).toISOString(),
    app: 'Code.exe',
    idle: false,
  });
}
let stored2 = await db.activitySample.count({
  where: { userId: noEnd.id, at: { gte: yStart, lt: minutes(yStart, 100) } },
});
check("every one of yesterday's 100 samples is stored", stored2 === 100, { stored2 });
row = await timesheetDay(noEnd, y);
check(
  'yesterday counts as worked from 9:00 to the last sample',
  near(row?.focusSec, 99 * 60, 120) && row?.unverifiedSec <= 60,
  row,
);
await endDay(noEnd);

const closedLive = await staff('auto-closed live day');
const yLive = await autoClosedDay(closedLive, y, yStart, minutes(yStart, 60));
check('today: Start Day [200]', (await closedLive.post('/activity/start-day', {})).status === 200);
// One every 2 minutes (the API takes up to 120 reports a minute from one person).
for (let m = 62; m <= 240; m += 2) {
  await closedLive.post('/activity/report', {
    at: minutes(yStart, m).toISOString(),
    app: 'Code.exe',
    idle: false,
  });
}
stored2 = await db.activitySample.count({
  where: { userId: closedLive.id, at: { gt: minutes(yStart, 60), lte: minutes(yStart, 240) } },
});
check('all 90 later samples of the auto-closed day are stored', stored2 === 90, { stored2 });
const moved = await db.workSession.findUnique({ where: { id: yLive.id } });
check(
  'its close moved to the last of them, and it rests on that evidence now (REPLAY)',
  moved?.endedAt?.getTime() === minutes(yStart, 240).getTime() && moved?.source === 'REPLAY',
  moved,
);
row = await timesheetDay(closedLive, y);
check('the day counts 9:00 to 1:00 PM', near(row?.focusSec, 4 * 3600, 120), row);
await endDay(closedLive);

console.log('\n# Re-audit M5: one late sample does not turn an auto-closed day into focus');
const oneLate = await staff('one late sample');
const oneDay = await autoClosedDay(oneLate, y, yStart, minutes(yStart, 60));
const before5 = await timesheetDay(oneLate, y);
check('before: an hour of focus', near(before5?.focusSec, 3600, 60), before5);
r = await oneLate.post('/activity/report', {
  at: wallToUtc(y, '21:00').toISOString(),
  app: 'Code.exe',
  idle: false,
});
check('a sample at 9:00 PM is taken [200]', r.status === 200, r.body);
const extended = await db.workSession.findUnique({ where: { id: oneDay.id } });
row = await timesheetDay(oneLate, y);
check(
  'the close moved to it, but the session is REPLAY: only the hour with samples is focus',
  extended?.source === 'REPLAY' &&
    near(row?.focusSec, 3600, 200) &&
    near(row?.unverifiedSec, 11 * 3600, 300),
  { session: extended, row },
);
const oldAgent = await staff('3.1 agent late sample', 'RXVisionAgent/3.1.0 (Windows)');
const oldDay = await autoClosedDay(oldAgent, y, yStart, minutes(yStart, 60));
await oldAgent.post('/activity/report', {
  at: wallToUtc(y, '21:00').toISOString(),
  app: 'Code.exe',
  idle: false,
});
const unmoved = await db.workSession.findUnique({ where: { id: oldDay.id } });
check(
  "a 3.1 agent's late sample moves nothing",
  unmoved?.endedAt?.getTime() === minutes(yStart, 60).getTime() && unmoved?.source === 'AGENT',
  unmoved,
);

console.log('\n# Re-audit M1: a refused replayed End Day leaves nothing behind');
const gated = await staff('refused End Day');
const gatedDay = await autoClosedDay(gated, y, wallToUtc(y, '09:30'), wallToUtc(y, '10:00'));
const notices0 = await noticesOf(gated);
r = await replay(gated, '/activity/end-day', wallToUtc(y, '18:00'));
expectError('replayed End Day at 6:00 PM with skips to explain', r, 409, 'SKIP_COMMENTS_REQUIRED');
const listed = r.body?.error?.details?.breaks ?? [];
check('the gate lists the auto-skips it would create', listed.length > 0, listed);
check(
  'no auto-skip, no notice, the day closed as it was',
  (await db.breakRecord.count({ where: { userId: gated.id } })) === 0 &&
    (await noticesOf(gated)) === notices0 &&
    (await db.workSession.findUnique({ where: { id: gatedDay.id } }))?.endReason === 'AUTO_CLOSED',
);
r = await replay(gated, '/activity/end-day', wallToUtc(y, '18:00'), {
  comments: listed.map((b) => ({ breakId: b.id, comment: 'Busy with the month-end release' })),
});
check('the same End Day with a comment on each [200]', r.status === 200, r.body);
const skips = await db.breakRecord.findMany({ where: { userId: gated.id } });
check(
  'the auto-skips exist now, with the ids the gate gave and their comments',
  skips.length === listed.length &&
    listed.every((b) => skips.some((s) => s.id === b.id && s.reason)),
  skips.map((s) => [s.id, s.kind, s.reason]),
);

console.log('\n# Re-audit M2: a replay past the latest end changes nothing and tells nobody');
const limit = await staff('past the latest end');
const limitDay = await autoClosedDay(limit, y, wallToUtc(y, '09:30'), wallToUtc(y, '10:00'));
const lunchSkip = await db.breakRecord.create({
  data: {
    userId: limit.id,
    date: y,
    kind: 'LUNCH',
    presenceType: 'LUNCH',
    scheduledStart: wallToUtc(y, '13:00'),
    durationMin: 30,
    startedAt: wallToUtc(y, '13:00'),
    timing: 'OUTSIDE_WINDOW',
    source: 'SYSTEM',
    outcome: 'AUTO_SKIPPED',
    approvalStatus: 'REJECTED',
    decidedAt: new Date(),
  },
});
const notices2 = await noticesOf(limit);
r = await replay(limit, '/breaks/quick/start', wallToUtc(y, '15:00'), { plannedMin: 5 });
check('a replayed quick break at 3:00 PM reopens the day [200]', r.status === 200, r.body);
for (let i = 0; i < 3; i += 1) {
  r = await replay(limit, '/breaks/quick/start', wallToUtc(y, '22:31'), { plannedMin: 5 });
  expectError(`a replayed quick break at 10:31 PM, past the latest end (#${i + 1})`, r, 409);
}
const relimit = await db.workSession.findUnique({ where: { id: limitDay.id } });
check(
  'the day is closed again (automatically, at its last input)',
  relimit?.endReason === 'AUTO_CLOSED' && relimit?.endedAt !== null,
  relimit,
);
check(
  'the decided (rejected) auto-skip is still there',
  !!(await db.breakRecord.findUnique({ where: { id: lunchSkip.id } })),
);
check('and nobody was told again that the day ended', (await noticesOf(limit)) === notices2, {
  before: notices2,
  after: await noticesOf(limit),
});

console.log(
  '\n# Re-audit M3, L2: replayed presence and away keep their own day; the SLA starts now',
);
const pres = await staff('replayed presence');
const d5 = todayKey(-5);
expectStatus(
  'replayed Start Day 9:00 AM',
  await replay(pres, '/activity/start-day', wallToUtc(d5, '09:00')),
  200,
);
expectStatus(
  'replayed free break (presence/start) at 11:00 AM',
  await replay(pres, '/presence/start', wallToUtc(d5, '11:00'), { type: 'BREAK' }),
  200,
);
expectStatus(
  'replayed End break at 11:30 AM',
  await replay(pres, '/breaks/end', wallToUtc(d5, '11:30')),
  200,
);
r = await replay(pres, '/away', wallToUtc(d5, '14:00'), {
  startedAt: wallToUtc(d5, '13:50').toISOString(),
  reasonKey: 'THINKING',
  comment: 'Working through the design',
});
check('replayed away answer at 2:00 PM, pending [200]', r.status === 200, r.body);
expectStatus('replayed End Day 6:00 PM', await endDay(pres, wallToUtc(d5, '18:00')), 200);
const presence = await db.presenceSession.findMany({ where: { userId: pres.id, type: 'BREAK' } });
check(
  'the break is on its own day, 11:00 to 11:30 AM',
  presence.length === 1 &&
    presence[0].date === d5 &&
    presence[0].startedAt.getTime() === wallToUtc(d5, '11:00').getTime() &&
    presence[0].endedAt?.getTime() === wallToUtc(d5, '11:30').getTime(),
  presence,
);
const away = await db.awayEvent.findFirst({ where: { userId: pres.id } });
check(
  "the away answer's approval clock starts on receipt, not 5 days ago",
  away?.status === 'PENDING' && away?.dueAt?.getTime() > Date.now() + 3_600_000,
  { dueAt: away?.dueAt, status: away?.status },
);
expectError(
  'a replayed presence/start after that End Day',
  await replay(pres, '/presence/start', wallToUtc(d5, '19:00'), { type: 'BREAK' }),
  409,
);

console.log('\n# Re-audit L3: an End Day older than the open day is refused');
const early = await staff('End Day before the start');
expectStatus('Start Day (live)', await early.post('/activity/start-day', {}), 200);
expectError(
  'a replayed End Day from an hour ago',
  await replay(early, '/activity/end-day', new Date(Date.now() - 3_600_000)),
  422,
  'EVENT_TIME_INVALID',
);
check(
  'the day is still open',
  !!(await db.workSession.findFirst({ where: { userId: early.id, endedAt: null } })),
);
await endDay(early);

console.log('\n# Re-audit M4, L4, L1: managers see only what their grants cover');
const mgr = async (label, grants) => {
  const email = `integrity.mgr.${label}.${RUN}@timechamp.test`;
  const res = await admin.post('/users', {
    firstName: 'Manager',
    lastName: `${label} ${RUN}`,
    email,
    password: PASS,
    role: 'MANAGER',
    departmentIds: [departments[0]?.id],
    grants,
  });
  check(`Manager (${label}) created [201]`, res.status === 201, res.body);
  return new Client(`manager ${label}`).login(email, PASS);
};
const timelineOnly = await mgr('timeline', { screenshots: false, timeline: true, activity: false });
const activityOnly = await mgr('activity', { screenshots: false, timeline: false, activity: true });
const month3 = d3.slice(0, 7);
const rowsOf = async (c) => data(await c.get(`/reports/team/month?month=${month3}`))?.rows ?? [];
const adminRows = await rowsOf(admin);
check(
  'the Admin sees quiet hours (the forged day had no activity)',
  adminRows.some((x) => x.totals.quietHours > 0),
  adminRows.map((x) => x.totals.quietHours),
);
const tlRows = await rowsOf(timelineOnly);
check(
  'a Manager without the activity grant: no quiet hours in any row',
  tlRows.length > 0 && tlRows.every((x) => x.totals.quietHours === 0 && !x.totals.needsALook),
  tlRows.map((x) => [x.totals.quietHours, x.totals.needsALook]),
);
const dayOf = async (c) =>
  data(await c.get(`/reports/person/${forger.id}/day?date=${d3}`))?.timeline;
check(
  'day report, timeline grant: the work and break spans',
  (await dayOf(timelineOnly))?.length > 0,
);
const noTimeline = await activityOnly.get(`/reports/person/${forger.id}/day?date=${d3}`);
check(
  'day report without the timeline grant: no spans, the totals stay',
  noTimeline.status === 200 &&
    data(noTimeline)?.timeline?.length === 0 &&
    data(noTimeline)?.summary?.unverifiedSec > 0,
  data(noTimeline)?.summary,
);
r = await timelineOnly.get(`/productivity/${early.id}`);
check(
  'productivity without the activity grant: no online or idle time',
  r.status === 200 && data(r)?.onlineSec === 0 && data(r)?.idleSec === 0,
  data(r),
);
expectStatus('productivity with it', await activityOnly.get(`/productivity/${early.id}`), 200);

console.log('\n# Re-audit L5: a department of another organisation is not found');
const strange = randomUUID();
expectError(
  'GET /team?departmentId=<not ours>',
  await admin.get(`/team?departmentId=${strange}`),
  404,
);
expectError(
  'GET /team/today?departmentId=<not ours>',
  await admin.get(`/team/today?departmentId=${strange}`),
  404,
);
expectStatus(
  'GET /team/today?departmentId=<ours>',
  await admin.get(`/team/today?departmentId=${departments[0]?.id}`),
  200,
);

console.log('\n# Re-audit: a replayed action dated in a locked month is refused');
const lockDate = todayKey(-2);
const lockMonth = lockDate.slice(0, 7);
const lockId = { companyId_month: { companyId: orgId, month: lockMonth } };
const lockedBefore = !!(await db.monthLock.findUnique({ where: lockId }));
if (!lockedBefore) {
  await db.monthLock.create({
    data: { companyId: orgId, month: lockMonth, lockedById: me.id, snapshot: {} },
  });
}
const inLocked = await staff('locked month');
expectError(
  `a replayed Start Day on ${lockDate}`,
  await replay(inLocked, '/activity/start-day', wallToUtc(lockDate, '09:00')),
  409,
  'MONTH_LOCKED',
);
check(
  'nothing was written',
  (await db.workSession.count({ where: { userId: inLocked.id } })) === 0,
);
if (!lockedBefore) await db.monthLock.delete({ where: lockId });

await db.$disconnect();
summary();
