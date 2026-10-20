// Follow-up fixes (25 checks): one person's current presence, Assign shifts hiding
// empty departments back on the default, no reason asked of a Super Admin, and an
// agent password sign-in marking the agent activated.
// Needs a freshly reset and seeded database: see README.md.
import { BASE, Client, check, expectStatus, summary, todayKey } from '../lib.mjs';

const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
const mgr = await new Client('manager').login('manager@timechamp.test', 'manager123');
const staff = await new Client('staff').login('user@timechamp.test', 'user123');

console.log('\n# Current presence of one person');
let r = expectStatus('staff reads own current presence', await staff.get('/presence/me/current'), 200);
// 3.1 (SPEC 3.9): NOT_STARTED before the first Start Day (or first activity report of an older agent).
check('own status is a known value', ['NOT_STARTED', 'WORKING', 'BREAK', 'LUNCH', 'MEETING', 'DAY_ENDED'].includes(r.body.data?.status), r.body);
expectStatus('staff cannot read the team endpoint', await staff.get(`/presence/team/${staff.user.id}/current`), 403);
r = expectStatus('manager reads a report', await mgr.get(`/presence/team/${staff.user.id}/current`), 200);
check('report status present', typeof r.body.data?.status === 'string', r.body);
expectStatus('manager cannot read the super admin', await mgr.get(`/presence/team/${sa.user.id}/current`), 403);
expectStatus('super admin reads anyone (a report of a manager)', await sa.get(`/presence/team/${staff.user.id}/current`), 200);
expectStatus('super admin reads a manager', await sa.get(`/presence/team/${mgr.user.id}/current`), 200);
expectStatus('unknown id is 404', await sa.get('/presence/team/00000000-0000-4000-8000-00000000ffff/current'), 404);
expectStatus('malformed id is 404', await sa.get('/presence/team/not-an-id/current'), 404);

console.log('\n# Live presence follows a break');
await staff.post('/presence/end');
r = await staff.post('/presence/start', { type: 'MEETING', note: 'live check' });
check('staff starts a meeting', r.status === 200 || r.status === 201, r.body);
r = await mgr.get(`/presence/team/${staff.user.id}/current`);
check('manager sees MEETING with elapsed time', r.body.data?.status === 'MEETING' && r.body.data?.elapsedSec >= 0, r.body);
await staff.post('/presence/end');
r = await mgr.get(`/presence/team/${staff.user.id}/current`);
// 3.1 (SPEC 3.9): no work session was opened (no Start Day, no activity report), so NOT_STARTED, not WORKING.
check('and NOT_STARTED once it ends (no work session yet)', r.body.data?.status === 'NOT_STARTED', r.body);

console.log('\n# Assign shifts: an empty department back on the default is hidden');
const shifts = (await sa.get('/shifts')).body.data;
const nonDefault = shifts.find((s) => !s.isDefault);
check('there is a non-default shift to use', !!nonDefault, shifts.map((s) => s.name));
const dept = `Live Check Empty ${Date.now().toString(36)}`;
r = await sa.put('/shift-assignments/departments', { department: dept, shiftId: nonDefault.id, companyId: nonDefault.companyId ?? undefined, effectiveFrom: todayKey() });
check('assign an empty department to a shift', r.status === 200, r.body);
let list = (await sa.get('/shift-assignments/departments')).body.data;
check('empty department with a real shift is listed', list.some((d) => d.department === dept), list.map((d) => d.department));
r = await sa.put('/shift-assignments/departments', { department: dept, shiftId: null, companyId: nonDefault.companyId ?? undefined, effectiveFrom: todayKey() });
check('move it back to the default', r.status === 200, r.body);
list = (await sa.get('/shift-assignments/departments')).body.data;
check('then it is no longer listed', !list.some((d) => d.department === dept), list.map((d) => d.department));
check('departments with people are still listed', list.some((d) => d.people > 0), list);

console.log('\n# Super Admin: no reason asked (nobody reviews it)');
let saDay = (await sa.get('/breaks/me/today')).body.data;
let staffDay = (await staff.get('/breaks/me/today')).body.data;
if (saDay?.shift && staffDay?.shift) {
  check('SA rules ask for no reason or overrun note', saDay.shift.rules.reasonOnLate === false && saDay.shift.rules.reasonOnEarly === false && saDay.shift.rules.overrunReason === false, saDay.shift.rules);
  check('staff rules keep the shift settings', staffDay.shift.rules.reasonOnLate === true, staffDay.shift.rules);
} else {
  check('both have a shift today (seeded default applies)', false, { sa: saDay?.mode, staff: staffDay?.mode });
}

console.log('\n# Agent password sign-in activates the agent');
let users = (await mgr.get('/users?limit=50')).body.data;
const rowOf = (l) => (Array.isArray(l) ? l : l?.items ?? []).find((u) => u.id === staff.user.id);
check('staff starts as NOT_ACTIVATED', rowOf(users)?.agentStatus === 'NOT_ACTIVATED', rowOf(users));
r = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'RXVisionAgent/3.0.0 (windows)' },
  body: JSON.stringify({ email: 'user@timechamp.test', password: 'user123' }),
});
check('agent sign-in succeeds', r.status === 200, r.status);
users = (await mgr.get('/users?limit=50')).body.data;
check('staff is no longer NOT_ACTIVATED', rowOf(users) && rowOf(users).agentStatus !== 'NOT_ACTIVATED', rowOf(users));
r = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
  body: JSON.stringify({ email: 'manager@timechamp.test', password: 'manager123' }),
});
const saList = (await sa.get('/users?limit=50')).body.data;
const mgrRow = (Array.isArray(saList) ? saList : saList?.items ?? []).find((u) => u.id === mgr.user.id);
check('a browser sign-in does not activate the agent', mgrRow?.agentStatus === 'NOT_ACTIVATED', mgrRow);

summary();
