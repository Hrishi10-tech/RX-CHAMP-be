// 4.0 live checks for the lead's areas: settings per organisation, calendar, quick
// breaks, pause and resume, the allowance, away answers, History, Team, Overview,
// the timesheet and offline replay. Needs a freshly reset and seeded database (4.0 seed).
import { randomUUID } from 'node:crypto';
import { AGENT_31_UA, AGENT_40_UA, check, Client, expectStatus, hm, summary, todayKey } from './lib.mjs';

const data = (r) => r.body?.data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function expectError(label, r, status, code) {
  check(`${label} [${status} ${code}]`, r.status === status && r.body?.error?.code === code, {
    got: r.status,
    body: r.body,
  });
  return r;
}
const plus = (d, min) => new Date(d.getTime() + min * 60000);
const RUN = Date.now().toString(36);
const today = todayKey();

const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
const admin = await new Client('orgadmin').login('orgadmin@timechamp.test', 'orgadmin123');
const mgr = await new Client('manager').login('manager@timechamp.test', 'manager123');
const staff = await new Client('staff-4.0', AGENT_40_UA).login('user@timechamp.test', 'user123');
const org = admin.user?.companyId ?? (await admin.get('/me')).body?.data?.organisation?.id;

console.log('\n# Tenancy');
expectError('Super Admin without an organisation: org endpoints refuse', await sa.get('/settings'), 400, 'ORG_REQUIRED');
sa.headers['x-org-id'] = '00000000-0000-0000-0000-0000000000c1';
expectStatus('Super Admin with X-Org-Id reads the organisation settings', await sa.get('/settings'), 200);


console.log('\n# Settings and calendar (Admin)');
let r = expectStatus('Admin sets the break buffer to 10', await admin.patch('/settings', { breakBufferMin: 10 }), 200);
check('buffer stored', data(r)?.breakBufferMin === 10, r.body);
expectError('a buffer of 61 is refused', await admin.patch('/settings', { breakBufferMin: 61 }), 400, 'VALIDATION_ERROR');
expectStatus('Manager cannot change settings', await mgr.patch('/settings', { breakBufferMin: 5 }), 403);
r = expectStatus('calendar for this year', await admin.get('/calendar'), 200);
check('12 months with working-day counts', data(r)?.months?.length === 12 && data(r).months.every((m) => m.workingDays > 0), data(r)?.months);
const holiday = todayKey(3);
r = expectStatus('Admin marks a holiday', await admin.put(`/calendar/days/${holiday}`, { isWorking: false, label: 'Test holiday' }), 200);
r = await admin.get('/calendar');
check('the holiday is listed', data(r)?.overrides?.some((o) => o.date === holiday && !o.isWorking && o.label === 'Test holiday'), data(r)?.overrides);
expectStatus('Manager reads the calendar', await mgr.get('/calendar'), 200);
expectStatus('Manager cannot change it', await mgr.put(`/calendar/days/${holiday}`, { isWorking: true }), 403);
expectError('a bad date', await admin.put('/calendar/days/2026-02-30', { isWorking: false }), 400, 'VALIDATION_ERROR');

console.log('\n# A shift around now');
const base = new Date();
const shiftDef = {
  name: `V40 lead ${RUN}`,
  start: hm(plus(base, -120)),
  end: hm(plus(base, 300)),
  workDays: [1, 2, 3, 4, 5, 6, 7],
  ringLeadMin: 1,
  ringDurationMin: 5,
  reasonOnEarly: false,
  reasonOnLate: false,
  reasonMinChars: 10,
  overrunReason: true,
  overrunGraceMin: 3,
  breaks: [
    { kind: 'MORNING', enabled: true, startTime: hm(plus(base, -60)), durationMin: 20, windowBeforeMin: 10, windowAfterMin: 10 },
    { kind: 'LUNCH', enabled: true, startTime: hm(plus(base, 0)), durationMin: 40, windowBeforeMin: 30, windowAfterMin: 60 },
    { kind: 'EVENING', enabled: true, startTime: hm(plus(base, 180)), durationMin: 20, windowBeforeMin: 10, windowAfterMin: 10 },
  ],
};
r = await sa.post('/shifts', shiftDef);
check('a 7-hour shift with 20 + 40 + 20 min breaks', r.status === 201, r.body);
const shift = data(r);
r = await sa.put('/shift-assignments/people', { userIds: [staff.user.id], shiftId: shift?.id, effectiveFrom: today });
check('staff on it', r.status === 200, r.body);

console.log('\n# Today (4.0 agent)');
r = expectStatus('Start Day', await staff.post('/activity/start-day', {}), 200);
r = expectStatus('today', await staff.get('/workday/me/today'), 200);
let t = data(r);
check('allowance = 80 + 10 min = 90 min', t?.allowance?.totalSec === 90 * 60 && t?.allowance?.scheduledSec === 80 * 60, t?.allowance);
check('target = 7 h - 90 min = 5 h 30', t?.targetSec === (420 - 90) * 60, { targetSec: t?.targetSec });
check('config: quick break minutes and idle reasons', JSON.stringify(t?.config?.quickBreakMinutes) === '[5,10,15]' && t?.config?.idle?.reasons?.length >= 4, t?.config);

console.log('\n# Quick break');
r = expectStatus('quick break of 5 min', await staff.post('/breaks/quick/start', { plannedMin: 5 }), 200);
check('it runs', data(r)?.record?.state === 'ACTIVE' && data(r)?.record?.kind === 'QUICK', data(r)?.record);
expectError('another quick break while on one', await staff.post('/breaks/quick/start', { plannedMin: 5 }), 409, 'ON_BREAK');
expectError('a quick break of 0 min', await staff.post('/breaks/quick/start', { plannedMin: 0 }), 400, 'VALIDATION_ERROR');
r = await staff.get('/breaks/me/today');
check('today lists it as active and in quick', data(r)?.active?.kind === 'QUICK' && data(r)?.quick?.length === 1, { active: data(r)?.active, quick: data(r)?.quick?.length });
await sleep(1500);
r = expectStatus('End break', await staff.post('/breaks/end', {}), 200);
check('ended, no overrun ask for a 4.0 agent', data(r)?.ended === true && data(r)?.record?.state === 'ENDED' && data(r)?.record?.approvalStatus === 'NOT_REQUIRED', data(r));
const quickId = data(r)?.record?.id;
r = expectStatus('manager: team breaks', await mgr.get('/breaks/team'), 200);
const staffRow = (data(r)?.rows ?? []).find((x) => x.user?.id === staff.user.id);
check('the quick break shows in team breaks (off-schedule list)', staffRow?.unscheduled?.some((b) => b.id === quickId && b.kind === 'QUICK'), staffRow?.unscheduled);

console.log('\n# Lunch: pause and resume');
r = expectStatus('start lunch', await staff.post('/breaks/start', { kind: 'LUNCH' }), 200);
const lunchId = data(r)?.record?.id;
await sleep(1200);
r = expectStatus('pause lunch', await staff.post(`/breaks/${lunchId}/pause`, {}), 200);
check('paused, can resume', data(r)?.state === 'PAUSED' && data(r)?.canResume === true, data(r));
expectError('pause again', await staff.post(`/breaks/${lunchId}/pause`, {}), 409, 'NOT_ACTIVE');
r = await staff.get('/breaks/me/today');
check('today shows the paused break and the slot state', data(r)?.pausedBreak?.id === lunchId && data(r)?.breaks?.find((b) => b.kind === 'LUNCH')?.state === 'PAUSED', { paused: data(r)?.pausedBreak?.id, slots: data(r)?.breaks?.map((b) => [b.kind, b.state]) });
expectError('a quick break cannot be paused', await staff.post(`/breaks/${data(r)?.quick?.[0]?.id}/pause`, {}), 409, 'NOT_PAUSABLE');
await sleep(1200);
r = expectStatus('resume lunch', await staff.post(`/breaks/${lunchId}/resume`, {}), 200);
check('two segments now', data(r)?.state === 'ACTIVE' && data(r)?.segments?.length === 2, data(r));
expectError('resume again', await staff.post(`/breaks/${lunchId}/resume`, {}), 409, 'NOT_PAUSED');
await sleep(1200);
r = expectStatus('end lunch', await staff.post('/breaks/end', {}), 200);
check('lunch ended with its taken time', data(r)?.record?.state === 'ENDED' && data(r)?.record?.takenSec >= 2, data(r)?.record);

console.log('\n# Meetings need the MoM sender from 4.0 agents');
expectError('meeting without MoM sender', await staff.post('/meetings/start', { agenda: 'Sync', participants: [{ name: 'Asha' }] }), 422, 'MOM_SENDER_REQUIRED');
r = expectStatus('meeting with MoM sender', await staff.post('/meetings/start', { agenda: 'Sync', participants: [{ name: 'Asha' }], momSender: 'Asha Rao' }), 200);
check('MoM sender stored', data(r)?.meeting?.momSender === 'Asha Rao', data(r)?.meeting);
expectError('quick break during a meeting', await staff.post('/breaks/quick/start', { plannedMin: 5 }), 409, 'IN_MEETING');
r = await staff.post(`/meetings/${data(r)?.meeting?.id}/end`, {});
check('meeting ended', r.status === 200, r.body);

console.log('\n# Away answers');
// Away time starts at the later of the away start and the last break or meeting end.
await sleep(2500);
r = await staff.get('/workday/me/today');
const idle = data(r)?.config?.idle;
const startAway = new Date(Date.now() - 4 * 60000).toISOString();
expectError('THINKING without a line', await staff.post('/away', { startedAt: startAway, reasonKey: 'THINKING' }), 422, 'AWAY_FIELDS');
expectError('an unknown reason', await staff.post('/away', { startedAt: startAway, reasonKey: 'NOPE' }), 422, 'AWAY_REASON_UNKNOWN');
r = expectStatus('THINKING with a line', await staff.post('/away', { startedAt: startAway, reasonKey: 'THINKING', comment: 'Planning the release' }), 200);
const awayId = data(r)?.away?.id;
const firstAway = data(r)?.away;
check('away time waits for approval', data(r)?.kind === 'AWAY' && data(r)?.away?.status === 'PENDING', data(r));
r = expectStatus('the same answer again (a retry) answers the stored one', await staff.post('/away', { startedAt: startAway, reasonKey: 'THINKING', comment: 'Planning the release' }), 200);
check('same away id', data(r)?.away?.id === awayId, data(r));
r = await staff.get('/workday/me/today');
check('pending away shows as +N if approved', data(r)?.away?.pendingSec > 0 && data(r)?.focus?.pendingPlusSec >= data(r)?.away?.pendingSec, { away: data(r)?.away, focus: data(r)?.focus });

console.log('\n# Approvals of away time');
r = expectStatus('manager lists approvals', await mgr.get('/approvals?type=AWAY'), 200);
const items = (r) => (Array.isArray(data(r)) ? data(r) : (data(r)?.items ?? []));
check('the away item is there for the department manager', items(r).some((i) => i.id === awayId && i.canDecide), data(r));
r = expectStatus('manager approves it', await mgr.post(`/approvals/away/${awayId}/approve`, { note: 'ok' }), 200);
check('approved', data(r)?.status === 'APPROVED' && data(r)?.type === 'AWAY', data(r));
// A second answer whose start falls inside the first (it arrived late) starts where the first ended.
r = expectStatus('a second away answer that overlaps the first', await staff.post('/away', { startedAt: new Date(Date.parse(startAway) + 60000).toISOString(), reasonKey: 'OTHER', comment: 'Helping a colleague' }), 200);
const secondAway = data(r)?.event ?? data(r)?.away;
check('accepted from the end of the first (no overlap), and named `event` too', !!data(r)?.event?.id && data(r)?.away?.id === data(r)?.event?.id && Date.parse(secondAway?.startedAt) >= Date.parse(firstAway?.endedAt) - 1000, { first: firstAway, second: secondAway });
expectStatus('upper-case type in the path (/approvals/AWAY/...)', await mgr.post(`/approvals/AWAY/${secondAway?.id}/approve`, { note: 'ok' }), 200);
r = await admin.get('/team?view=all');
const rowOfStaff = JSON.stringify(data(r) ?? {}).includes('"agentVersion":"4.0.0"');
check("Team shows the 4.0 agent's version", rowOfStaff, (data(r)?.people ?? data(r)?.rows ?? []).map?.((x) => x.agentVersion));
r = await staff.get('/workday/me/today');
check('approved away counts as focus (not subtracted)', data(r)?.focus?.awayApprovedSec > 0 && data(r)?.away?.pendingSec === 0, data(r)?.focus);
expectStatus('staff cannot list approvals', await staff.get('/approvals'), 403);

r = expectStatus('a short meeting while away', await staff.post('/away', {
  startedAt: new Date().toISOString(),
  reasonKey: 'MEETING',
  comment: 'Hallway sync on the release',
  participants: [{ name: 'Ravi' }, { name: 'Neha' }],
  momSender: 'Ravi',
}), 200);
check('away meeting pending', data(r)?.away?.reasonKind === 'MEETING' && data(r)?.away?.momSender === 'Ravi', data(r));

console.log('\n# History');
r = expectStatus('History of this month', await staff.get('/workday/me/history'), 200);
const h = data(r);
check('month shape', h?.month === today.slice(0, 7) && Array.isArray(h?.days) && h.days.length >= 28, { month: h?.month });
const hd = h?.days?.find((x) => x.date === today);
check('today in History: in progress with its target', hd?.status === 'IN_PROGRESS' && hd?.targetSec === (420 - 90) * 60, hd);
check('the holiday is not a working day', h?.days?.find((x) => x.date === holiday)?.isWorkingDay === false || holiday.slice(0, 7) !== today.slice(0, 7), h?.days?.find((x) => x.date === holiday));
check('meetings list carries the away meeting and its MoM sender', h?.meetings?.some((m) => m.kind === 'AWAY_MEETING' && m.momSender === 'Ravi'), h?.meetings);
check('away list', h?.away?.some((a) => a.id === awayId && a.status === 'APPROVED'), h?.away);

console.log('\n# Team and Overview');
r = expectStatus('Admin: Team', await admin.get('/team'), 200);
check('Team counts and the staff row', data(r)?.counts?.all >= 2 && data(r)?.people?.some((p) => p.id === staff.user.id), data(r)?.counts);
expectError('Manager without grants: Team', await mgr.get('/team'), 403, 'GRANT_REQUIRED');
r = expectStatus('Admin: Overview', await admin.get('/overview'), 200);
check('Overview sections', !!data(r)?.today && !!data(r)?.month && Array.isArray(data(r)?.departments) && Array.isArray(data(r)?.hourly), Object.keys(data(r) ?? {}));
r = expectStatus('Manager: Overview', await mgr.get('/overview'), 200);
check('Manager without the activity grant: no hourly', data(r)?.hourly === undefined, Object.keys(data(r) ?? {}));
expectStatus('Staff: no Overview', await staff.get('/overview'), 403);

console.log('\n# Timesheet');
const from = `${today.slice(0, 7)}-01`;
r = expectStatus('Admin: timesheet JSON', await admin.get(`/reports/person/${staff.user.id}/timesheet?from=${from}&to=${today}`), 200);
check('one row per day with 12-hour times', data(r)?.rows?.length >= 1 && data(r)?.rows?.find((x) => x.date === today)?.in12?.match(/^\d{1,2}:\d{2} (AM|PM)$/), data(r)?.rows?.find((x) => x.date === today));
r = await admin.get(`/reports/person/${staff.user.id}/timesheet.xlsx?from=${from}&to=${today}`);
check('timesheet Excel', r.status === 200 && r.file?.length > 1000, { status: r.status });
expectError('more than 366 days', await admin.get(`/reports/person/${staff.user.id}/timesheet?from=2024-01-01&to=${today}`), 400, 'VALIDATION_ERROR');

console.log('\n# Offline replay');
const ev = randomUUID();
const at = new Date(Date.now() - 2 * 60000).toISOString();
r = await staff.post('/breaks/quick/start', { plannedMin: 10 }, { 'x-client-event-id': ev, 'x-event-at': at });
check('a replayed quick break starts at the event time', r.status === 200 && data(r)?.record?.startedAt?.slice(0, 16) === at.slice(0, 16), data(r)?.record);
const again = await staff.post('/breaks/quick/start', { plannedMin: 10 }, { 'x-client-event-id': ev, 'x-event-at': at });
check('the same event again answers the same body', again.status === 200 && data(again)?.record?.id === data(r)?.record?.id, again.body);
r = await staff.post('/breaks/end', {}, { 'x-client-event-id': randomUUID(), 'x-event-at': new Date(Date.now() - 60000).toISOString() });
check('replayed End break', r.status === 200 && data(r)?.ended === true, r.body);
expectError('an event far in the future', await staff.post('/breaks/end', {}, { 'x-client-event-id': randomUUID(), 'x-event-at': new Date(Date.now() + 3600000).toISOString() }), 422, 'EVENT_TIME_INVALID');
expectError('an event older than the previous one', await staff.post('/breaks/end', {}, { 'x-client-event-id': randomUUID(), 'x-event-at': new Date(Date.now() - 30 * 60000).toISOString() }), 422, 'EVENT_TIME_INVALID');
expectError('a bad event id', await staff.post('/breaks/end', {}, { 'x-client-event-id': 'nope' }), 400, 'VALIDATION_ERROR');

console.log('\n# People made for this run (Admin)');
const PASS = 'LeadRun#2026';
const depts = data(await admin.get('/departments')) ?? [];
const eng = depts.find((d) => d.managers?.length) ?? depts[0];
async function newStaff(label, departmentId) {
  const email = `${label}.${RUN}@lead.test`;
  const res = expectStatus(`create ${label}`, await admin.post('/users', { firstName: 'Run', lastName: label, email, password: PASS, role: 'USER', departmentId }), 201);
  return { id: data(res)?.created?.[0]?.id, email };
}
const oldUser = await newStaff('old-agent', eng?.id);

console.log('\n# A department with no manager: its items wait for the Admin');
r = expectStatus('department without a manager', await admin.post('/departments', { name: `No manager ${RUN}` }), 201);
const lonelyDept = data(r)?.id;
const lonely = await newStaff('lonely', lonelyDept);
const lonelyC = await new Client('lonely', AGENT_40_UA).login(lonely.email, PASS);
expectStatus('lonely: Start Day', await lonelyC.post('/activity/start-day', { startedAt: new Date(Date.now() - 8 * 60000).toISOString() }), 200);
r = expectStatus('lonely: away THINKING', await lonelyC.post('/away', { startedAt: new Date(Date.now() - 4 * 60000).toISOString(), reasonKey: 'THINKING', comment: 'Reading the brief' }), 200);
const lonelyAway = data(r)?.away?.id;
r = await admin.get('/approvals?type=AWAY');
check("in the Admin's Mine at once (nobody else can decide it)", items(r).some((i) => i.id === lonelyAway && i.canDecide), data(r));
r = await mgr.get('/approvals?type=AWAY');
check('not with a manager of another department', !items(r).some((i) => i.id === lonelyAway), data(r));
expectStatus('the Admin decides it', await admin.post(`/approvals/away/${lonelyAway}/approve`, { note: 'ok' }), 200);
r = expectStatus('team month of that department only', await admin.get(`/reports/team/month?departmentId=${lonelyDept}`), 200);
check('only its people, each with the department', (data(r)?.rows ?? data(r)?.people ?? []).length === 1 && JSON.stringify(data(r)).includes(lonely.id) && JSON.stringify(data(r)).includes(`"departmentId":"${lonelyDept}"`), (data(r)?.rows ?? []).map?.((x) => x.person?.email));
r = expectStatus('team day of that department only', await admin.get(`/reports/team/day?departmentId=${lonelyDept}`), 200);
check('team day: only its people', (data(r)?.rows ?? []).length === 1 && data(r).rows[0].person?.id === lonely.id, (data(r)?.rows ?? []).map((x) => x.person?.email));
expectStatus('a manager cannot ask for a department that is not theirs', await mgr.get(`/reports/team/month?departmentId=${lonelyDept}`), 404);
await lonelyC.post('/activity/end-day', {});

console.log('\n# A 3.1 agent keeps working');
const old = await new Client('agent-3.1', AGENT_31_UA).login(process.env.OLD_EMAIL ?? oldUser.email, process.env.OLD_PASSWORD ?? PASS);
r = await sa.put('/shift-assignments/people', { userIds: [old.user.id], shiftId: shift?.id, effectiveFrom: today });
check('3.1 agent user on the shift', r.status === 200, r.body);
expectStatus('3.1: Start Day', await old.post('/activity/start-day', {}), 200);
r = expectStatus('3.1: today (old fields still there)', await old.get('/breaks/me/today'), 200);
check('3.1 fields: breaks, activeBreak, unscheduled', Array.isArray(data(r)?.breaks) && 'activeBreak' in (data(r) ?? {}) && Array.isArray(data(r)?.unscheduled), Object.keys(data(r) ?? {}));
expectStatus('3.1: start lunch', await old.post('/breaks/start', { kind: 'LUNCH' }), 200);
r = expectStatus('3.1: end lunch with askToCount false', await old.post('/breaks/end', { askToCount: false }), 200);
check('3.1: ended', data(r)?.ended === true, data(r));
r = expectStatus('3.1: meeting without MoM sender is fine', await old.post('/meetings/start', { agenda: 'Old agent sync', participants: [] }), 200);
await old.post(`/meetings/${data(r)?.meeting?.id}/end`, {});
expectStatus('3.1: End Day', await old.post('/activity/end-day', {}), 200);

console.log('\n# Clean up');
await admin.del(`/calendar/days/${holiday}`);
r = expectStatus('End Day', await staff.post('/activity/end-day', {}), 200);
summary();
