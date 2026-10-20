// Team month for 100 people x 31 days, timed through the API (SPEC 3.7 reports).
// Writes August 2026 for 100 people (5 managers, 95 staff) straight into the local
// database: sessions, breaks, skips, overruns, meetings and an activity sample a
// minute (about 1.4 million). Then times GET /reports/team/month as a Super Admin.
// Needs a freshly reset and seeded database and a running API: see README.md.
// BUDGET_MS (default 1500) is the slowest median accepted.
import { randomUUID } from 'node:crypto';
import { Client, check, expectStatus, summary, SEED_ORG } from './lib.mjs';
import { openDb, wallToUtc } from './db.mjs';

const MONTH = '2026-08';
const DATES = Array.from({ length: 31 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
const GENERAL_ID = '00000000-0000-0000-0000-0000000000d1'; // seeded default shift, 09:30 to 18:30 Mon to Sat
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 1500);
const RUNS = 5;
const at = (date, minute) => wallToUtc(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
const isSunday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
const addDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const db = await openDb();
// Already written (a second run on the same database): time it again, nothing else.
const written = !!(await db.user.findFirst({ where: { email: 'perf.m1@timechamp.test' } }));
const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
// 4.0: a Super Admin acts inside one organisation.
sa.headers['x-org-id'] = SEED_ORG;
const people = [];
if (written) {
  console.log('\n# August is already written: timing only');
  for (const email of ['perf.m1@timechamp.test', 'perf.m1.s1@timechamp.test']) {
    people.push(await db.user.findFirst({ where: { email }, select: { id: true, departmentId: true } }));
  }
} else {
  console.log('\n# 100 people');
  const roles = Object.fromEntries((await db.role.findMany()).map((r) => [r.name, r.id]));
  const joined = wallToUtc('2026-07-01', '09:00');
  // 4.0: five departments of the seeded organisation, each with its manager and 19 Staff.
  const depts = [];
  for (let m = 1; m <= 5; m++) {
    const departmentId = randomUUID();
    depts.push({ id: departmentId, companyId: SEED_ORG, name: `Perf Team ${m}`, icon: 'code' });
    const mid = randomUUID();
    people.push({ id: mid, email: `perf.m${m}@timechamp.test`, role: roles.MANAGER, managerId: null, dept: `Perf Team ${m}`, departmentId });
    for (let s = 1; s <= 19; s++) {
      people.push({ id: randomUUID(), email: `perf.m${m}.s${s}@timechamp.test`, role: roles.USER, managerId: mid, dept: `Perf Team ${m}`, departmentId });
    }
  }
  await db.department.createMany({ data: depts });
  await db.user.createMany({
    data: people.map((p, i) => ({
      id: p.id, email: p.email, passwordHash: 'not-for-sign-in', firstName: 'Perf', lastName: `Person ${i + 1}`,
      roleId: p.role, managerId: p.managerId, department: p.dept, departmentId: p.departmentId,
      companyId: SEED_ORG, createdAt: joined,
    })),
  });
  await db.managerDepartment.createMany({
    data: people.filter((p) => p.role === roles.MANAGER).map((p) => ({ managerId: p.id, departmentId: p.departmentId })),
  });
  check('100 people', people.length === 100);

  console.log('\n# August');
  const rows = { sessions: [], presence: [], breaks: [], meetings: [] };
  const SLOTS = [['MORNING', 11 * 60, 15], ['LUNCH', 13 * 60, 30], ['EVENING', 16 * 60, 15]];
  people.forEach((p, pi) => {
    DATES.forEach((date, di) => {
      if (isSunday(date) || (pi + di) % 17 === 0) return; // Sundays off, an absence now and then
      const j = (pi * 7 + di * 3) % 20;
      const spans = (pi + di) % 7 === 0
        ? [[9 * 60 + 30 + j, 14 * 60], [14 * 60 + 20, 18 * 60 + 35 + j]]
        : [[9 * 60 + 30 + j, 18 * 60 + 35 + j]];
      for (const [s, e] of spans) {
        rows.sessions.push({ id: randomUUID(), userId: p.id, date, startedAt: at(date, s), endedAt: at(date, e), endReason: 'USER', source: 'AGENT' });
      }
      SLOTS.forEach(([kind, start, len], k) => {
        const skipped = (pi + di + k) % 13 === 0;
        const over = !skipped && (pi + di + k) % 10 === 0;
        const minutes = over ? len + 8 : len;
        const startedAt = at(date, start + ((pi + k) % 4));
        const presenceId = skipped ? null : randomUUID();
        if (presenceId) {
          rows.presence.push({ id: presenceId, userId: p.id, type: kind === 'LUNCH' ? 'LUNCH' : 'BREAK', date, startedAt, endedAt: at(date, start + ((pi + k) % 4) + minutes), durationSec: minutes * 60 });
        }
        const reviewed = skipped || over;
        const status = !reviewed ? 'NOT_REQUIRED' : (pi + di) % 5 === 0 ? 'REJECTED' : 'APPROVED';
        const scheduled = at(date, start);
        rows.breaks.push({
          id: randomUUID(), userId: p.id, date, kind, seq: 0, presenceType: kind === 'LUNCH' ? 'LUNCH' : 'BREAK',
          shiftId: GENERAL_ID, shiftName: 'General', scheduledStart: scheduled, durationMin: len,
          windowOpen: new Date(scheduled.getTime() - 30 * 60_000), windowClose: new Date(scheduled.getTime() + 60 * 60_000),
          presenceSessionId: presenceId, startedAt, timing: 'ON_TIME', reason: skipped ? 'Month-end run' : null,
          overrunReason: over ? 'Long payer call' : null, approvalStatus: status,
          approverRole: reviewed ? 'MANAGER' : null, approverId: reviewed ? p.managerId : null,
          decidedById: reviewed ? p.managerId : null, decidedAt: reviewed ? at(date, 18 * 60) : null,
          outcome: skipped ? 'SKIPPED' : 'TAKEN', overrunSec: skipped ? null : over ? 480 : 0, overrunAsked: over,
          dueAt: reviewed ? new Date(startedAt.getTime() + 48 * 3600_000) : null,
        });
      });
      if ((pi + di) % 3 === 0) {
        rows.meetings.push({
          id: randomUUID(), userId: p.id, date, mode: 'PAST', agenda: 'Weekly sync', participants: [],
          startedAt: at(date, 15 * 60), endedAt: at(date, 15 * 60 + 30), durationSec: 1800,
          approvalStatus: 'APPROVED', approverRole: 'MANAGER', approverId: p.managerId, decidedById: p.managerId,
          decidedAt: at(date, 17 * 60), dueAt: at(addDay(date), 15 * 60),
        });
      }
    });
  });
  await db.workSession.createMany({ data: rows.sessions });
  await db.presenceSession.createMany({ data: rows.presence });
  await db.breakRecord.createMany({ data: rows.breaks });
  await db.meetingRecord.createMany({ data: rows.meetings });
  // A sample a minute inside every session, a tenth of them idle (one SQL statement).
  await db.$executeRawUnsafe(`
    INSERT INTO activity_samples (id, user_id, date, at, duration_sec, idle, app, title)
    SELECT md5(ws.id::text || g::text)::uuid, ws.user_id, ws.date, ws.started_at + g * interval '1 minute', 60,
           g % 10 = 9, 'EXCEL.EXE', 'Claims batch'
    FROM work_sessions ws
    CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM ws.ended_at - ws.started_at) / 60)::int - 1) g
    WHERE ws.date LIKE '${MONTH}-%' AND ws.user_id IN (SELECT id FROM users WHERE email LIKE 'perf.%')`);
  await db.$executeRawUnsafe('VACUUM ANALYZE activity_samples');
  const samples = await db.activitySample.count({ where: { date: { startsWith: `${MONTH}-` } } });
  console.log(`  ${rows.sessions.length} sessions, ${rows.breaks.length} break records, ${rows.meetings.length} meetings, ${samples} samples`);
  check('about 1.4 million samples', samples > 1_000_000, samples);
}

console.log('\n# Team month, timed');
const time = async (label, path, runs = RUNS) => {
  const t = performance.now();
  const first = await sa.get(path); // the first request (and the shape check)
  console.log(`  ${label}: first request ${Math.round(performance.now() - t)} ms`);
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await sa.get(path);
    ms.push(performance.now() - t0);
    if (r.status !== 200) return { first, ms: [Infinity] };
  }
  ms.sort((a, b) => a - b);
  console.log(`  ${label}: median ${Math.round(ms[Math.floor(ms.length / 2)])} ms (min ${Math.round(ms[0])}, max ${Math.round(ms[ms.length - 1])})`);
  return { first, ms };
};
const all = await time('everyone (Super Admin)', `/reports/team/month?month=${MONTH}`);
expectStatus('team month', all.first, 200);
const rowsOut = all.first.body?.data?.rows ?? [];
check('a row per person in scope (100 and the demo accounts)', rowsOut.length >= 100, rowsOut.length);
check('31 days each', rowsOut.every((x) => x.days.length === 31), rowsOut[0]?.days?.length);
const median = all.ms[Math.floor(all.ms.length / 2)];
check(`median under ${BUDGET_MS} ms`, median < BUDGET_MS, Math.round(median));
const team = await time('one department (Super Admin, departmentId)', `/reports/team/month?month=${MONTH}&departmentId=${people[1].departmentId}`);
check('20 rows (the department: 19 Staff and their manager)', team.first.body?.data?.rows?.length === 20, team.first.body?.data?.rows?.length);
const one = await time('one person\'s month', `/reports/person/${people[1].id}/month?month=${MONTH}`);
check('person month', one.first.status === 200 && one.first.body?.data?.days?.length === 31, one.first.status);

await db.$disconnect();
summary();
