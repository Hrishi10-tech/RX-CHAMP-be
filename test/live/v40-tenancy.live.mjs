// 4.0 live checks across two organisations: isolation (every cross-organisation
// read or write answers 404), the Super Admin's organisation switch, approval
// routing by department, manager view grants, per-organisation settings and
// calendar, and sign-out keys; and the audit fixes: each part of a day behind its
// own grant, over HTTP and the live sockets (H2, M1), report runs (L1), someone
// else's break or meeting (L2), setup codes (L5) and the brief profile (L6).
// Needs the 4.0 seed (organisation A); it creates organisation B itself, with a
// run suffix so it can run again. L1 writes three report runs directly (db.mjs:
// local databases only), since runs are made by a monthly job.
import { randomUUID } from 'node:crypto';
import { openDb } from './db.mjs';
import { AGENT_40_UA, check, Client, expectStatus, summary, todayKey } from './lib.mjs';
import { openSocket } from './socket.mjs';

const data = (r) => r.body?.data;
const items = (r) => (Array.isArray(data(r)) ? data(r) : (data(r)?.items ?? data(r)?.users ?? []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function expectError(label, r, status, code) {
  check(`${label} [${status}${code ? ' ' + code : ''}]`, r.status === status && (!code || r.body?.error?.code === code), {
    got: r.status,
    body: r.body,
  });
  return r;
}
const RUN = Date.now().toString(36);
const PASS = 'Tenancy#2026x';
const today = todayKey();

const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
const adminA = await new Client('adminA').login('orgadmin@timechamp.test', 'orgadmin123');
const mgrA = await new Client('managerA').login('manager@timechamp.test', 'manager123');
const staffA = await new Client('staffA', AGENT_40_UA).login('user@timechamp.test', 'user123');
const meA = data(await adminA.get('/me'));
const orgA = meA?.organisation?.id;
check('organisation A from /me', !!orgA, meA);

console.log('\n# Organisation B (Super Admin)');
let r = expectStatus('create organisation B', await sa.post('/organisations', { name: `Tenancy B ${RUN}` }), 201);
const orgB = data(r)?.id;
expectError('the same name again', await sa.post('/organisations', { name: `tenancy  b ${RUN}` }), 409, 'ORG_EXISTS');
expectStatus('an Admin cannot create organisations', await adminA.post('/organisations', { name: `X ${RUN}` }), 403);
r = expectStatus(
  'create the Admin of B',
  await sa.post(`/organisations/${orgB}/admin`, { firstName: 'Bea', lastName: 'Admin', email: `admin.b.${RUN}@tenancy.test`, password: PASS }),
  201,
);
expectError(
  'a second Admin is refused',
  await sa.post(`/organisations/${orgB}/admin`, { firstName: 'Two', lastName: 'Admin', email: `admin2.b.${RUN}@tenancy.test`, password: PASS }),
  409,
  'ADMIN_EXISTS',
);
const adminB = await new Client('adminB').login(`admin.b.${RUN}@tenancy.test`, PASS);
check('Admin B belongs to B', data(await adminB.get('/me'))?.organisation?.id === orgB);

console.log('\n# Departments and people of B (Admin B)');
const icons = data(await adminB.get('/departments/icons'));
const icon = Array.isArray(icons) ? (icons[0]?.key ?? icons[0]) : undefined;
r = expectStatus('department Ops', await adminB.post('/departments', { name: 'Ops', icon }), 201);
const deptB = data(r)?.id;
const create = async (label, body) => {
  const res = expectStatus(label, await adminB.post('/users', { password: PASS, ...body }), 201);
  return data(res)?.created?.[0]?.id ?? data(res)?.id;
};
const mgrBId = await create('Manager B (timeline only)', {
  firstName: 'Mo',
  lastName: 'Manager',
  email: `mgr.b.${RUN}@tenancy.test`,
  role: 'MANAGER',
  departmentIds: [deptB],
  grants: { screenshots: false, timeline: true, activity: false },
});
const staffBId = await create('Staff B1', { firstName: 'Sam', lastName: 'Staff', email: `staff1.b.${RUN}@tenancy.test`, role: 'USER', departmentId: deptB });
const staffB2Id = await create('Staff B2', { firstName: 'Sue', lastName: 'Staff', email: `staff2.b.${RUN}@tenancy.test`, role: 'USER', departmentId: deptB });
expectError('Staff with two departments', await adminB.post('/users', {
  password: PASS, firstName: 'X', lastName: 'Y', email: `x.b.${RUN}@tenancy.test`, role: 'USER', departmentIds: [deptB, deptB],
}), 400);
const mgrB = await new Client('managerB').login(`mgr.b.${RUN}@tenancy.test`, PASS);
const staffB = await new Client('staffB', AGENT_40_UA).login(`staff1.b.${RUN}@tenancy.test`, PASS);
const staffB2 = await new Client('staffB2', AGENT_40_UA).login(`staff2.b.${RUN}@tenancy.test`, PASS);
const staffAId = staffA.user?.id ?? data(await staffA.get('/me'))?.id;
r = data(await mgrB.get('/me'));
check('/me: Manager B grants and permissions', r?.grants?.timeline === true && r?.grants?.screenshots === false && r?.permissions?.canManagePeople === false, r);

console.log('\n# Isolation: every cross-organisation call answers 404');
const cross = [
  ['Admin A reads a person of B', adminA, 'GET', `/users/${staffBId}`],
  ['Admin A edits a person of B', adminA, 'PATCH', `/users/${staffBId}`, { designation: 'x' }],
  ['Admin A blocks a person of B', adminA, 'POST', `/users/${staffBId}/status`, { status: 'DISABLED' }],
  ['Admin A grants a manager of B', adminA, 'POST', `/users/${mgrBId}/grants`, { screenshots: true, timeline: true, activity: true }],
  ['Admin A renames a department of B', adminA, 'PATCH', `/departments/${deptB}`, { name: 'Hacked' }],
  ['Admin A reads a day report of B', adminA, 'GET', `/reports/person/${staffBId}/day?date=${today}`],
  ['Admin A reads a month of B', adminA, 'GET', `/reports/person/${staffBId}/month?month=${today.slice(0, 7)}`],
  ['Admin A reads a timesheet of B', adminA, 'GET', `/reports/person/${staffBId}/timesheet?from=${today}&to=${today}`],
  ['Admin A reads a timeline of B', adminA, 'GET', `/presence/team/${staffBId}/timeline`],
  ['Admin A reads screenshots of B', adminA, 'GET', `/screenshots?userId=${staffBId}`],
  ['Admin A asks for a capture of B', adminA, 'POST', '/screenshots/capture', { userId: staffBId }],
  ['Admin A reads activity of B', adminA, 'GET', `/activity/user/${staffBId}/hourly`],
  ['Admin A reads analytics of B', adminA, 'GET', `/analytics/${staffBId}`],
  ['Manager A reads a person of B', mgrA, 'GET', `/users/${staffBId}`],
  ['Manager A reads a timeline of B', mgrA, 'GET', `/presence/team/${staffBId}/timeline`],
  ['Admin B reads a person of A', adminB, 'GET', `/users/${staffAId}`],
  ['Manager B reads a person of A', mgrB, 'GET', `/users/${staffAId}`],
  ['Manager B reads a timeline of A', mgrB, 'GET', `/presence/team/${staffAId}/timeline`],
  ['Admin B team breaks of a department of A', adminB, 'GET', `/breaks/team?departmentId=${meA?.department?.id ?? '00000000-0000-0000-0000-0000000000e1'}`],
];
for (const [label, c, method, path, body] of cross) {
  const res = await c.req(method, path, body);
  check(`${label} [404]`, res.status === 404, { got: res.status, body: res.body });
}
r = await adminA.get('/users?limit=100');
check('Admin A list has no one of B', !items(r).some((u) => [staffBId, staffB2Id, mgrBId].includes(u.id)), r.status);
r = await adminA.get('/team?view=all');
check('Admin A Team has no one of B', r.status === 200 && !JSON.stringify(data(r)).includes(staffBId), r.status);
r = await adminA.get('/departments');
check('Admin A departments do not include Ops of B', r.status === 200 && !(data(r) ?? []).some((d) => d.id === deptB), data(r));
r = await adminB.get('/users?limit=100');
check('Admin B sees exactly the people of B', items(r).length >= 4 && items(r).every((u) => u.id !== staffAId), items(r).map((u) => u.email));

console.log('\n# Super Admin organisation switch');
sa.headers['x-org-id'] = orgB;
r = expectStatus('Super Admin in B lists people', await sa.get('/users?limit=100'), 200);
check('people of B, none of A', items(r).some((u) => u.id === staffBId) && !items(r).some((u) => u.id === staffAId), items(r).length);
expectStatus('Super Admin in B reads the settings of B', await sa.get('/settings'), 200);
sa.headers['x-org-id'] = '00000000-0000-0000-0000-00000000dead';
expectError('an unknown organisation', await sa.get('/settings'), 404, 'ORG_NOT_FOUND');
delete sa.headers['x-org-id'];
expectError('no organisation picked', await sa.get('/settings'), 400, 'ORG_REQUIRED');
r = expectStatus('platform overview', await sa.get('/overview/platform'), 200);
const orgs = data(r)?.organisations ?? data(r);
check('both organisations listed', Array.isArray(orgs) && [orgA, orgB].every((id) => orgs.some((o) => o.id === id)), data(r));
r = expectStatus('organisations list', await sa.get('/organisations'), 200);
const rowB = (data(r) ?? []).find((o) => o.id === orgB);
check('B counts: 2 staff, 1 manager, 1 department', rowB?.counts?.staff === 2 && rowB?.counts?.managers === 1 && rowB?.counts?.departments === 1, rowB);
expectError('B cannot be deleted while people remain', await sa.del(`/organisations/${orgB}`), 409, 'ORG_NOT_EMPTY');

console.log('\n# Manager view grants (B)');
expectStatus('Manager B reads a timeline (granted)', await mgrB.get(`/presence/team/${staffBId}/timeline`), 200);
expectError('Manager B screenshots (not granted)', await mgrB.get(`/screenshots?userId=${staffBId}`), 403, 'GRANT_REQUIRED');
expectError('Manager B hourly activity (not granted)', await mgrB.get(`/activity/user/${staffBId}/hourly`), 403, 'GRANT_REQUIRED');
expectStatus('Manager B cannot create people', await mgrB.post('/users', { firstName: 'N', lastName: 'O', email: `no.${RUN}@tenancy.test`, password: PASS, role: 'USER', departmentId: deptB }), 403);
expectStatus('Manager B cannot edit people', await mgrB.patch(`/users/${staffBId}`, { designation: 'x' }), 403);
expectStatus('Manager B cannot reset a password', await mgrB.post(`/users/${staffBId}/password`, { newPassword: PASS }), 403);
expectStatus('Manager B cannot switch screenshots', await mgrB.post(`/users/${staffBId}/screenshots`, { enabled: false }), 403);
expectStatus('Manager B cannot switch input tracking', await mgrB.post(`/users/${staffBId}/idle`, { enabled: false }), 403);
expectStatus('Manager B cannot ask for a capture', await mgrB.post('/screenshots/capture', { userId: staffBId }), 403);
expectStatus('Manager B cannot make sign-out keys', await mgrB.post('/signout-keys', { scope: 'ORG' }), 403);
expectStatus('Manager B cannot grant themselves', await mgrB.post(`/users/${mgrBId}/grants`, { screenshots: true, timeline: true, activity: true }), 403);
r = expectStatus('Admin B grants screenshots', await adminB.post(`/users/${mgrBId}/grants`, { screenshots: true, timeline: true, activity: false }), 200);
await sleep(300);
expectStatus('Manager B now reads screenshots', await mgrB.get(`/screenshots?userId=${staffBId}`), 200);
expectError('grants on Staff are refused', await adminB.post(`/users/${staffBId}/grants`, { screenshots: true, timeline: false, activity: false }), 400, 'NOT_A_MANAGER');

console.log('\n# Approval routing by department');
expectStatus('Staff B starts the day', await staffB.post('/activity/start-day', { startedAt: new Date(Date.now() - 8 * 60000).toISOString() }), 200);
r = expectStatus(
  'Staff B: away THINKING',
  await staffB.post('/away', { startedAt: new Date(Date.now() - 4 * 60000).toISOString(), reasonKey: 'THINKING', comment: 'Working through the design' }),
  200,
);
const awayB = data(r)?.away?.id;
check('pending for a manager', data(r)?.away?.status === 'PENDING', data(r));
r = await mgrB.get('/approvals?type=AWAY');
check('Manager B sees it and can decide', items(r).some((i) => i.id === awayB && i.canDecide), data(r));
r = await adminB.get('/approvals?type=AWAY&scope=all');
check('Admin B sees it (all)', items(r).some((i) => i.id === awayB), data(r));
r = await adminB.get('/approvals?type=AWAY');
check('not in Admin B mine (a department manager decides it)', r.status === 200 && !items(r).some((i) => i.id === awayB), data(r));
r = await adminA.get('/approvals?type=AWAY&scope=all');
check('Admin A (all) does not', r.status === 200 && !items(r).some((i) => i.id === awayB), data(r));
r = await mgrA.get('/approvals?type=AWAY');
check('Manager A does not', r.status === 200 && !items(r).some((i) => i.id === awayB), data(r));
expectStatus('Admin A cannot approve it', await adminA.post(`/approvals/away/${awayB}/approve`, { note: 'x' }), 404);
expectStatus('Manager A cannot approve it', await mgrA.post(`/approvals/away/${awayB}/approve`, { note: 'x' }), 404);
r = expectStatus('Manager B approves', await mgrB.post(`/approvals/away/${awayB}/approve`, { note: 'ok' }), 200);
check('approved', data(r)?.status === 'APPROVED', data(r));

console.log('\n# Audit H2, M1: each part of a person\'s day needs its own grant');
// Manager B now holds screenshots and timeline, not activity. Two more managers of
// the same department: one with no grant, one with the activity grant only.
const mgr0Id = await create('Manager B0 (no grants)', {
  firstName: 'Manager',
  lastName: 'Without Grants',
  email: `mgr0.b.${RUN}@tenancy.test`,
  role: 'MANAGER',
  departmentIds: [deptB],
  grants: { screenshots: false, timeline: false, activity: false },
});
const mgrActId = await create('Manager B2 (activity only)', {
  firstName: 'Manager',
  lastName: 'Activity Only',
  email: `mgract.b.${RUN}@tenancy.test`,
  role: 'MANAGER',
  departmentIds: [deptB],
  grants: { screenshots: false, timeline: false, activity: true },
});
const mgr0 = await new Client('managerB0').login(`mgr0.b.${RUN}@tenancy.test`, PASS);
const mgrAct = await new Client('managerBact').login(`mgract.b.${RUN}@tenancy.test`, PASS);
check('two more managers', !!mgr0Id && !!mgrActId);

// Live pushes, opened before Staff B2 does anything.
const sockets = {
  admin: await openSocket(adminB, '/activity'),
  timeline: await openSocket(mgrB, '/activity'),
  activity: await openSocket(mgrAct, '/activity'),
  none: await openSocket(mgr0, '/activity'),
  presenceTimeline: await openSocket(mgrB, '/presence'),
  presenceNone: await openSocket(mgr0, '/presence'),
};
await sleep(800); // the rooms are joined just after the connection

// Staff B2 works twelve minutes in Code, idle for three of them (the day started
// 13 minutes ago, as the agent replays a Start Day it could not send at once).
expectStatus(
  'Staff B2 starts the day',
  await staffB2.post('/activity/start-day', {}, { 'x-client-event-id': randomUUID(), 'x-event-at': new Date(Date.now() - 13 * 60000).toISOString() }),
  200,
);
let stored = 0;
for (let m = 12; m >= 0; m -= 1) {
  const s = await staffB2.post('/activity/report', {
    at: new Date(Date.now() - m * 60000).toISOString(),
    app: 'Code.exe',
    title: 'plan.md - Visual Studio Code',
    idle: m >= 5 && m <= 7,
  });
  if (s.status === 200) stored += 1;
}
check('Staff B2 activity reported', stored === 13, stored);
expectStatus('Staff B2 back to working (a presence push)', await staffB2.post('/presence/end', {}), 200);
await sleep(1000);

const pushes = (s) => s.received('activity:update').filter((u) => u.userId === staffB2Id);
const full = pushes(sockets.admin);
check('Admin B gets the full live push (app and active time)', full.length > 0 && full.some((u) => u.app === 'Code.exe') && full.some((u) => u.activeSec > 0), full.at(-1));
const tl = pushes(sockets.timeline);
check('timeline-only Manager: the app, no active or idle time', tl.length > 0 && tl.some((u) => u.app === 'Code.exe') && tl.every((u) => u.activeSec === 0 && u.idleSec === 0), tl.at(-1));
const act = pushes(sockets.activity);
check('activity-only Manager: active time, no app, title or top apps', act.length > 0 && act.some((u) => u.activeSec > 0) && act.every((u) => u.app === null && u.title === null && (u.topApps ?? []).length === 0), act.at(-1));
check('a Manager with no grant gets no live activity', sockets.none.received('activity:update').length === 0, sockets.none.events);
check('a Manager with a grant gets the presence push', sockets.presenceTimeline.received('presence:update').length > 0, sockets.presenceTimeline.events);
check('a Manager with no grant gets no presence push', sockets.presenceNone.received('presence:update').length === 0, sockets.presenceNone.events);
for (const s of Object.values(sockets)) s.close();

for (const [label, path] of [
  ['GET /team/today', '/team/today'],
  ['GET /presence/team/live', '/presence/team/live'],
  ['GET /presence/team/summary', '/presence/team/summary'],
  ['GET /presence/team/:id/current', `/presence/team/${staffB2Id}/current`],
  ['GET /presence/team/:id/history', `/presence/team/${staffB2Id}/history`],
  ['GET /presence/team/:id/timeline', `/presence/team/${staffB2Id}/timeline`],
  ['GET /activity/user/:id/daily', `/activity/user/${staffB2Id}/daily`],
  ['GET /analytics/:id', `/analytics/${staffB2Id}`],
]) {
  expectError(`no grant: ${label}`, await mgr0.get(path), 403, 'GRANT_REQUIRED');
}

const rowOf = (res) => (data(res)?.rows ?? []).find((x) => x.user?.id === staffB2Id);
r = await adminB.get('/team/today');
check('Team today, Admin: hourly activity', r.status === 200 && (rowOf(r)?.hourly ?? []).some((h) => (h.activeMin ?? h.activeSec ?? h.active ?? 0) > 0), rowOf(r)?.hourly);
r = await mgrB.get('/team/today');
check('Team today, timeline-only Manager: no hourly activity, no quiet hours', r.status === 200 && rowOf(r) && rowOf(r).hourly.length === 0 && rowOf(r).quietHours === 0 && data(r).totals.quietHours === 0, rowOf(r));
r = await mgrAct.get('/team/today');
check('Team today, activity-only Manager: hourly activity', r.status === 200 && (rowOf(r)?.hourly ?? []).length > 0, rowOf(r)?.hourly);
r = await mgrB.get('/presence/team/summary');
const sumRow = items(r).find((x) => x.userId === staffB2Id);
check('presence summary, timeline-only Manager: idle time is 0', r.status === 200 && sumRow?.totals?.idleSec === 0, { status: r.status, body: data(r) });

r = await adminB.get(`/activity/user/${staffB2Id}/daily`);
const dayAll = data(r);
check('daily, Admin: apps, active and idle time, hourly', dayAll?.topApps?.length > 0 && dayAll?.activeSec > 0 && dayAll?.idleSec > 0 && dayAll?.hourly?.length > 0, dayAll);
r = await mgrB.get(`/activity/user/${staffB2Id}/daily`);
check('daily, timeline-only Manager: apps only', r.status === 200 && data(r)?.topApps?.length > 0 && data(r)?.activeSec === 0 && data(r)?.idleSec === 0 && data(r)?.hourly?.length === 0, data(r));
r = await mgrAct.get(`/activity/user/${staffB2Id}/daily`);
check('daily, activity-only Manager: active time, no apps or sites', r.status === 200 && data(r)?.activeSec > 0 && data(r)?.topApps?.length === 0 && data(r)?.topWebsites?.length === 0, data(r));
r = await adminB.get(`/analytics/${staffB2Id}`);
check('analytics, Admin: top apps and the active KPI', data(r)?.topApps?.length > 0 && data(r)?.kpis?.active?.value > 0, data(r)?.kpis);
r = await mgrB.get(`/analytics/${staffB2Id}`);
check('analytics, timeline-only Manager: top apps, no active or idle KPI', r.status === 200 && data(r)?.topApps?.length > 0 && data(r)?.kpis?.active?.value === 0 && data(r)?.kpis?.idle?.value === 0 && data(r)?.timeline?.length === 0, data(r)?.kpis);
r = await mgrAct.get(`/analytics/${staffB2Id}`);
check('analytics, activity-only Manager: no top apps', r.status === 200 && data(r)?.topApps?.length === 0 && data(r)?.kpis?.active?.value > 0, data(r)?.topApps);

console.log('\n# Audit L1: report runs keep activity figures for the activity grant');
const db = await openDb();
const lastMonth = todayKey(-32).slice(0, 7);
const runSummary = { people: 2, focusSec: 7200, paidSec: 7200, quietHours: 3, needsALook: 1 };
for (const [ownerId, scope] of [[mgrBId, 'TEAM'], [mgrActId, 'TEAM'], [data(await adminB.get('/me'))?.id, 'ALL']]) {
  await db.reportRun.create({ data: { companyId: orgB, month: lastMonth, scope, ownerId, summary: runSummary } });
}
const runOf = async (c) => (data(await c.get('/reports/runs'))?.items ?? []).find((x) => x.month === lastMonth);
let run = await runOf(mgrB);
check('timeline-only Manager: the run without quiet hours or needs-a-look', run && run.summary.focusSec === 7200 && !('quietHours' in run.summary) && !('needsALook' in run.summary), run);
run = await runOf(mgrAct);
check('activity-only Manager: quiet hours and needs-a-look', run?.summary?.quietHours === 3 && run?.summary?.needsALook === 1, run);
run = await runOf(adminB);
check('Admin B: quiet hours and needs-a-look', run?.summary?.quietHours === 3 && run?.summary?.needsALook === 1, run);
await db.$disconnect();

console.log("\n# Audit L2: someone else's break or meeting is not found");
r = expectStatus('Staff B2 takes a quick break', await staffB2.post('/breaks/quick/start', { plannedMin: 5 }), 200);
const breakB2 = data(r)?.record?.id;
expectStatus('and ends it', await staffB2.post('/breaks/end', {}), 200);
expectError("Staff B1 comments on B2's break", await staffB.post(`/breaks/${breakB2}/comment`, { comment: 'not mine' }), 404);
expectError('Staff B1 comments on an unknown break (the same answer)', await staffB.post('/breaks/00000000-0000-4000-8000-000000000bad/comment', { comment: 'x' }), 404);
r = expectStatus('Staff B2 starts a meeting', await staffB2.post('/meetings/start', { agenda: 'Sync', participants: [{ name: 'Guest' }], momSender: 'Guest' }), 200);
const meetingB2 = data(r)?.meeting?.id;
expectError("Staff B1 ends B2's meeting", await staffB.post(`/meetings/${meetingB2}/end`, {}), 404);
expectStatus('Staff B2 ends it', await staffB2.post(`/meetings/${meetingB2}/end`, {}), 200);

console.log('\n# Audit L5: setup codes only from the Admin or a Super Admin, never for yourself');
expectError('Staff for themselves', await staffB2.get(`/agent/setup-code?userId=${staffB2Id}`), 403);
expectError('a Manager for their Staff', await mgrB.get(`/agent/setup-code?userId=${staffB2Id}`), 403);
expectError('a Manager for themselves', await mgrB.get(`/agent/setup-code?userId=${mgrBId}`), 403);
const adminBId = data(await adminB.get('/me'))?.id;
expectError('the Admin for themselves', await adminB.get(`/agent/setup-code?userId=${adminBId}`), 403);
expectError('the Admin of A for Staff of B', await adminA.get(`/agent/setup-code?userId=${staffB2Id}`), 404);
r = expectStatus('the Admin for their Staff', await adminB.get(`/agent/setup-code?userId=${staffB2Id}`), 200);
check('a setup code', /^RXV1\./.test(data(r)?.code ?? ''), data(r)?.userId);
sa.headers['x-org-id'] = orgB;
expectStatus('a Super Admin for the Admin', await sa.get(`/agent/setup-code?userId=${adminBId}`), 200);
delete sa.headers['x-org-id'];

console.log('\n# Audit L6: a Manager gets the brief profile');
r = expectStatus('Manager B reads Staff B2', await mgrB.get(`/users/${staffB2Id}`), 200);
check('the brief row only', JSON.stringify(Object.keys(data(r) ?? {}).sort()) === JSON.stringify(['department', 'departmentRef', 'designation', 'email', 'id', 'name']), data(r));
r = await adminB.get(`/users/${staffB2Id}`);
check('the Admin gets the full profile', data(r)?.role === 'USER' && 'status' in (data(r) ?? {}), Object.keys(data(r) ?? {}));
r = await staffB2.get(`/users/${staffB2Id}`);
check('Staff get their own full profile', data(r)?.role === 'USER' && 'screenshotsEnabled' in (data(r) ?? {}), Object.keys(data(r) ?? {}));
r = await mgrB.get(`/users/${mgrBId}`);
check('a Manager gets their own full profile', data(r)?.role === 'MANAGER', Object.keys(data(r) ?? {}));

console.log('\n# Settings and calendar per organisation');
const bufA = data(await adminA.get('/settings'))?.breakBufferMin;
expectStatus('Admin B sets a 15 min buffer', await adminB.patch('/settings', { breakBufferMin: 15 }), 200);
check('A keeps its buffer', data(await adminA.get('/settings'))?.breakBufferMin === bufA, bufA);
check('B has 15', data(await adminB.get('/settings'))?.breakBufferMin === 15);
const day = todayKey(5);
expectStatus('Admin B marks a holiday', await adminB.put(`/calendar/days/${day}`, { isWorking: false, label: `B holiday ${RUN}` }), 200);
r = await adminA.get(`/calendar?year=${day.slice(0, 4)}`);
check('A calendar unchanged', !(data(r)?.overrides ?? []).some((o) => o.label === `B holiday ${RUN}`), data(r)?.overrides);
r = await staffB.get('/workday/me/today');
check('Staff B today carries the B buffer', data(r)?.config?.breakBufferMin === 15, data(r)?.config);
r = await staffA.get('/workday/me/today');
check('Staff A today keeps the A buffer', data(r)?.config?.breakBufferMin === bufA, data(r)?.config);

console.log('\n# Sign-out keys');
r = expectStatus('Admin B: a key for Staff B1', await adminB.post('/signout-keys', { scope: 'USERS', userIds: [staffBId] }), 201);
const keyB = data(r)?.phrase;
check('a phrase of 5 words and a number', /^([a-z]+ ){5}\d{2}$/.test(keyB ?? ''), data(r));
r = expectStatus('Admin A: an organisation-wide key of A', await adminA.post('/signout-keys', { scope: 'ORG' }), 201);
const keyA = data(r)?.phrase;
expectError('Admin A cannot key a person of B', await adminA.post('/signout-keys', { scope: 'USERS', userIds: [staffBId] }), 404);
expectError('Staff B2 with the B1 key', await staffB2.post('/agent/sign-out', { key: keyB }), 403, 'SIGNOUT_KEY_INVALID');
expectError('Staff B1 with the key of A', await staffB.post('/agent/sign-out', { key: keyA }), 403, 'SIGNOUT_KEY_INVALID');
expectError('Staff B2 cannot quit with any key', await staffB2.post('/agent/quit-check', { key: keyB }), 403, 'QUIT_NOT_ALLOWED');
r = expectStatus('Staff B1 signs out with the key', await staffB.post('/agent/sign-out', { key: `  ${keyB.toUpperCase()} ` }), 200);
check('signed out', data(r)?.signedOut === true, data(r));
r = await staffB.post('/auth/refresh', {});
check('the agent session is gone (refresh refused)', r.status === 401, { got: r.status, body: r.body });
r = await adminB.get('/signout-keys');
check('Admin B lists the key', (data(r) ?? []).some((k) => k.scope === 'USERS'), data(r));
r = expectStatus('Admin A revokes its key', await adminA.post(`/signout-keys/${(data(await adminA.get('/signout-keys')) ?? [])[0]?.id}/revoke`, {}), 200);
expectError('the revoked key no longer works', await staffA.post('/agent/sign-out', { key: keyA }), 403, 'SIGNOUT_KEY_INVALID');

console.log("\n# The Super Admin hears the picked organisation's config pushes");
const saSock = await openSocket(sa, '/notifications', { orgId: orgB });
const otherSock = await openSocket(sa, '/notifications');
await adminB.put(`/calendar/days/${todayKey(6)}`, { isWorking: false, label: `B push ${RUN}` });
await sleep(1000);
check('config:changed (CALENDAR) reached the Super Admin in B', saSock.received('config:changed').some((p) => p?.kind === 'CALENDAR'), saSock.events.map((e) => e.name));
check('not a Super Admin socket with no organisation picked', !otherSock.received('config:changed').length, otherSock.events.map((e) => e.name));
saSock.close();
otherSock.close();

console.log('\n# Clean up');
await staffB2.post('/activity/end-day', {});
summary();
