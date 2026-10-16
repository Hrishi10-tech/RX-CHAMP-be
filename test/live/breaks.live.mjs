// Shifts, assignments, the break flow and approvals, end to end (101 checks).
// Needs a freshly reset and seeded database: see README.md.
import { Client, check, expectStatus, summary, hm, todayKey, minutesFromNow } from './lib.mjs';

const sa = await new Client('superadmin').login('admin@timechamp.test', 'admin123');
const mgr = await new Client('manager').login('manager@timechamp.test', 'manager123');
const staff = await new Client('staff').login('user@timechamp.test', 'user123');
const today = todayKey();
const tomorrow = todayKey(1);

console.log('\n# Shifts');
let r = expectStatus('SA lists shifts', await sa.get('/shifts'), 200);
check('two seeded shifts', r.body.data.length === 2, r.body.data.map((s) => s.name));
const general = r.body.data.find((s) => s.name === 'General');
const early = r.body.data.find((s) => s.name === 'Early');
check('General is default', general?.isDefault === true);
check('General usage counts the 3 seeded people', general?.usage.people === 3, general?.usage);
check('derived ring times', general?.breaks[0].ringStart === '10:59' && general?.breaks[0].ringEnd === '11:04', general?.breaks[0]);

expectStatus('staff cannot list shifts', await staff.get('/shifts'), 403);
expectStatus('manager can list shifts', await mgr.get('/shifts'), 200);
expectStatus('manager cannot create a shift', await mgr.post('/shifts', {}), 403);

r = expectStatus('validate flags overlapping windows', await sa.post('/shifts/validate', {
  name: 'Bad', start: '09:00', end: '18:00', workDays: [1, 2, 3, 4, 5],
  breaks: [
    { kind: 'MORNING', enabled: true, startTime: '11:00', durationMin: 15, windowBeforeMin: 30, windowAfterMin: 120 },
    { kind: 'LUNCH', enabled: true, startTime: '12:30', durationMin: 30, windowBeforeMin: 30, windowAfterMin: 60 },
  ],
}), 200);
check('validate: invalid with overlap message', r.body.data.valid === false && r.body.data.problems.some((p) => /overlaps/.test(p)), r.body.data);

r = expectStatus('create rejects breaks out of order', await sa.post('/shifts', {
  name: 'Backwards', start: '09:00', end: '18:00', workDays: [1, 2, 3, 4, 5],
  breaks: [
    { kind: 'MORNING', enabled: true, startTime: '15:00', durationMin: 15, windowBeforeMin: 30, windowAfterMin: 30 },
    { kind: 'LUNCH', enabled: true, startTime: '13:00', durationMin: 30, windowBeforeMin: 30, windowAfterMin: 30 },
  ],
}), 400);
check('error code SHIFT_INVALID with details', r.body.error?.code === 'SHIFT_INVALID' && Array.isArray(r.body.error?.details?.problems), r.body);

// A shift built around "now": morning is 10 min late, lunch opens later, evening later still.
const name = `Smoke ${Date.now() % 100000}`;
const def = {
  name,
  start: hm(minutesFromNow(-180)),
  end: hm(minutesFromNow(300)),
  workDays: [1, 2, 3, 4, 5, 6, 7],
  ringLeadMin: 1, ringDurationMin: 5, reasonOnEarly: true, reasonOnLate: true, reasonMinChars: 10,
  overrunReason: true, overrunGraceMin: 0,
  breaks: [
    { kind: 'MORNING', enabled: true, startTime: hm(minutesFromNow(-10)), durationMin: 15, windowBeforeMin: 30, windowAfterMin: 60 },
    { kind: 'LUNCH', enabled: true, startTime: hm(minutesFromNow(90)), durationMin: 30, windowBeforeMin: 30, windowAfterMin: 60 },
    { kind: 'EVENING', enabled: true, startTime: hm(minutesFromNow(180)), durationMin: 15, windowBeforeMin: 30, windowAfterMin: 60 },
  ],
};
r = expectStatus('SA creates the smoke shift', await sa.post('/shifts', def), 201);
const smoke = r.body.data;
expectStatus('duplicate name refused', await sa.post('/shifts', def), 409);

console.log('\n# Assignments');
r = expectStatus('manager overrides own staff to smoke shift', await mgr.put('/shift-assignments/people', {
  userIds: [staff.user.id, sa.user.id], shiftId: smoke.id, effectiveFrom: today,
}), 200);
check('staff assigned, super admin skipped (not their team)', r.body.data.assigned.length === 1 && r.body.data.skipped[0]?.reason === 'Not in your team', r.body.data);
expectStatus('past date refused', await mgr.put('/shift-assignments/people', { userIds: [staff.user.id], shiftId: smoke.id, effectiveFrom: '2020-01-01' }), 400);
expectStatus('manager cannot set department shifts', await mgr.put('/shift-assignments/departments', { department: 'Engineering', shiftId: early.id, effectiveFrom: tomorrow }), 403);

r = expectStatus('manager lists own people', await mgr.get('/shift-assignments/people'), 200);
const staffRow = r.body.data.find((p) => p.userId === staff.user.id);
check('manager sees only their staff', r.body.data.length === 1, r.body.data.map((p) => p.email));
check('staff on smoke via OVERRIDE', staffRow?.shift?.id === smoke.id && staffRow?.source === 'OVERRIDE', staffRow);

r = expectStatus('SA schedules Engineering on Early from tomorrow', await sa.put('/shift-assignments/departments', {
  department: 'Engineering', shiftId: early.id, effectiveFrom: tomorrow,
}), 200);
const eng = r.body.data.find((d) => d.departmentKey === 'engineering');
check('engineering: no department shift today, Early upcoming', eng && eng.current === null && eng.upcoming?.shift?.id === early.id && eng.people === 2 && eng.overrides === 1, eng);

console.log('\n# Staff break day');
r = expectStatus('staff gets today', await staff.get('/breaks/me/today'), 200);
let day = r.body.data;
check('mode SCHEDULED on smoke shift', day.mode === 'SCHEDULED' && day.shift?.id === smoke.id && day.breaks.length === 3, { mode: day.mode, shift: day.shift });
check('rules travel with the day', day.shift?.rules?.reasonMinChars === 10 && day.shift?.rules?.overrunReason === true);
check('local times are HH:MM', /^\d\d:\d\d$/.test(day.breaks[0].local.start));

r = expectStatus('lunch is not open yet', await staff.post('/breaks/start', { kind: 'LUNCH' }), 409);
check('BREAK_NOT_OPEN with opensAt', r.body.error?.code === 'BREAK_NOT_OPEN' && !!r.body.error?.details?.opensAt, r.body.error);

r = expectStatus('late morning without a reason', await staff.post('/breaks/start', { kind: 'MORNING' }), 422);
check('REASON_REQUIRED with minutes and min chars', r.body.error?.code === 'REASON_REQUIRED' && r.body.error.details.timing === 'LATE' && r.body.error.details.minutesOff >= 9 && r.body.error.details.minChars === 10, r.body.error);
expectStatus('too-short reason', await staff.post('/breaks/start', { kind: 'MORNING', reason: 'call' }), 422);

r = expectStatus('late morning with a reason', await staff.post('/breaks/start', { kind: 'MORNING', reason: 'Finishing a customer call' }), 200);
const rec = r.body.data.record;
check('record LATE, pending, presence BREAK', rec.timing === 'LATE' && rec.approvalStatus === 'PENDING' && r.body.data.presence.status === 'BREAK', r.body.data);

r = expectStatus('second start of same break', await staff.post('/breaks/start', { kind: 'MORNING', reason: 'Finishing a customer call' }), 409);
check('BREAK_ALREADY_TAKEN', r.body.error?.code === 'BREAK_ALREADY_TAKEN', r.body.error);

r = expectStatus('presence shows BREAK', await staff.get('/presence/me/current'), 200);
check('presence status BREAK', r.body.data.status === 'BREAK', r.body.data);

r = expectStatus('today shows active break', await staff.get('/breaks/me/today'), 200);
check('activeBreak is the morning', r.body.data.activeBreak?.id === rec.id && r.body.data.breaks[0].record?.inProgress === true);

console.log('\n# Approvals (manager)');
await new Promise((res) => setTimeout(res, 300));
r = expectStatus('manager approvals list', await mgr.get('/breaks/approvals'), 200);
let item = r.body.data.find((i) => i.id === rec.id);
check('pending item routed to manager, decidable', item && item.canDecide === true && item.user.id === staff.user.id && item.reason === 'Finishing a customer call', r.body.data);
r = expectStatus('manager summary', await mgr.get('/breaks/approvals/summary'), 200);
check('summary pendingToday = 1', r.body.data.pendingToday === 1, r.body.data);
r = expectStatus('manager notifications', await mgr.get('/notifications'), 200);
const notes = r.body.data?.notifications ?? r.body.data;
check('manager got BREAK_APPROVAL_REQUESTED', JSON.stringify(notes).includes('BREAK_APPROVAL_REQUESTED'), notes);

expectStatus('staff cannot open approvals', await staff.get('/breaks/approvals'), 403);

console.log('\n# End break');
r = expectStatus('staff ends break with overrun reason', await staff.post('/breaks/end', { overrunReason: 'Call ran long' }), 200);
check('ended, record closed', r.body.data.ended === true && r.body.data.record?.inProgress === false, r.body.data);
r = expectStatus('end again is a no-op', await staff.post('/breaks/end', {}), 200);
check('ended false on retry', r.body.data.ended === false);
r = expectStatus('presence back to WORKING', await staff.get('/presence/me/current'), 200);
check('status WORKING', r.body.data.status === 'WORKING', r.body.data);

console.log('\n# Decide');
expectStatus('reject needs a real note', await mgr.post(`/breaks/approvals/${rec.id}/reject`, { note: 'no' }), 400);
r = expectStatus('manager rejects', await mgr.post(`/breaks/approvals/${rec.id}/reject`, { note: 'Please plan calls around breaks' }), 200);
check('REJECTED with note', r.body.data.approvalStatus === 'REJECTED' && r.body.data.decisionNote === 'Please plan calls around breaks', r.body.data);
r = expectStatus('second decision conflicts', await mgr.post(`/breaks/approvals/${rec.id}/approve`, {}), 409);
check('ALREADY_DECIDED', r.body.error?.code === 'ALREADY_DECIDED');
r = expectStatus('manager reopens', await mgr.post(`/breaks/approvals/${rec.id}/reopen`, {}), 200);
check('back to PENDING', r.body.data.approvalStatus === 'PENDING');
r = expectStatus('manager approves', await mgr.post(`/breaks/approvals/${rec.id}/approve`, { note: 'OK this time' }), 200);
check('APPROVED', r.body.data.approvalStatus === 'APPROVED' && r.body.data.decidedByName === 'Maya Reddy', r.body.data);
await new Promise((res) => setTimeout(res, 300));
r = expectStatus('staff notifications', await staff.get('/notifications'), 200);
check('staff got BREAK_DECIDED', JSON.stringify(r.body.data).includes('BREAK_DECIDED'));
r = expectStatus('staff history', await staff.get('/breaks/me/history?days=7'), 200);
check('history has the approved morning', r.body.data.items.some((i) => i.id === rec.id && i.approvalStatus === 'APPROVED'), r.body.data);

console.log('\n# Manager breaks go to Super Admin');
r = expectStatus('SA puts manager on smoke shift', await sa.put('/shift-assignments/people', { userIds: [mgr.user.id], shiftId: smoke.id, effectiveFrom: today }), 200);
check('manager assigned', r.body.data.assigned.includes(mgr.user.id), r.body.data);
r = expectStatus('manager starts a late morning', await mgr.post('/breaks/start', { kind: 'MORNING', reason: 'Was in a client review' }), 200);
const mrec = r.body.data.record;
check('routed to Super Admin pool', mrec.approvalStatus === 'PENDING' && mrec.approverRole === 'SUPER_ADMIN', mrec);
r = expectStatus('manager does not see own break to approve', await mgr.get('/breaks/approvals?status=ALL'), 200);
check('not in manager list', !r.body.data.some((i) => i.id === mrec.id));
expectStatus('manager cannot decide own break', await mgr.post(`/breaks/approvals/${mrec.id}/approve`, {}), 403);
r = expectStatus('SA sees it in mine', await sa.get('/breaks/approvals'), 200);
check('SA mine includes manager break', r.body.data.some((i) => i.id === mrec.id && i.canDecide), r.body.data.map((i) => i.id));
expectStatus('SA approves manager break', await sa.post(`/breaks/approvals/${mrec.id}/approve`, {}), 200);
expectStatus('manager ends break', await mgr.post('/breaks/end', {}), 200);

console.log('\n# Older agent path (presence/start BREAK)');
r = expectStatus('staff starts plain BREAK', await staff.post('/presence/start', { type: 'BREAK' }), 200);
await new Promise((res) => setTimeout(res, 500));
r = expectStatus('today lists it as unscheduled', await staff.get('/breaks/me/today'), 200);
const legacy = r.body.data.unscheduled[0];
check('OUTSIDE_WINDOW + PENDING (morning taken, evening not open)', legacy && legacy.timing === 'OUTSIDE_WINDOW' && legacy.approvalStatus === 'PENDING' && legacy.source === 'LEGACY', r.body.data.unscheduled);
expectStatus('presence/end ends it', await staff.post('/presence/end', {}), 200);

console.log('\n# Team view');
r = expectStatus('manager team day', await mgr.get('/breaks/team'), 200);
const row = r.body.data.rows.find((x) => x.user.id === staff.user.id);
check('morning TAKEN, lunch UPCOMING', row?.cells[0]?.status === 'TAKEN' && row?.cells[1]?.status === 'UPCOMING', row?.cells);
check('totals count late and pending', r.body.data.totals.late >= 1 && r.body.data.totals.pending >= 1, r.body.data.totals);

console.log('\n# Reroute when a manager is blocked');
r = await sa.post(`/users/${mgr.user.id}/status`, { status: 'DISABLED' });
check('SA blocks the manager', r.status === 200 || r.status === 201, r);
await new Promise((res) => setTimeout(res, 600));
r = expectStatus('SA mine now holds the staff legacy break', await sa.get('/breaks/approvals'), 200);
check('legacy break re-routed to Super Admin pool', r.body.data.some((i) => i.id === legacy.id && i.approverRole === 'SUPER_ADMIN'), r.body.data.map((i) => [i.id, i.approverRole]));
r = await sa.post(`/users/${mgr.user.id}/status`, { status: 'ACTIVE' });
check('SA unblocks the manager', r.status === 200 || r.status === 201, r);
r = expectStatus('manager can sign in again', await mgr.post('/auth/login', { email: 'manager@timechamp.test', password: 'manager123' }), 200);

console.log('\n# Shift lifecycle');
r = expectStatus('cannot delete an assigned shift', await sa.del(`/shifts/${smoke.id}`), 409);
check('SHIFT_IN_USE', r.body.error?.code === 'SHIFT_IN_USE', r.body.error);
r = expectStatus('cannot delete the default', await sa.del(`/shifts/${general.id}`), 409);
check('SHIFT_IS_DEFAULT', r.body.error?.code === 'SHIFT_IS_DEFAULT');
expectStatus('staff back to department shift', await sa.put('/shift-assignments/people', { userIds: [staff.user.id, mgr.user.id], shiftId: null, effectiveFrom: today }), 200);
r = expectStatus('staff resolves to the default again', await staff.get('/breaks/me/today'), 200);
check('default General today', r.body.data.shift?.id === general.id && r.body.data.source === 'DEFAULT', { shift: r.body.data.shift, source: r.body.data.source });
expectStatus('now the smoke shift can go', await sa.del(`/shifts/${smoke.id}`), 200);

console.log('\n# Day ended');
expectStatus('staff ends the day', await staff.post('/activity/end-day', {}), 200);
r = await staff.post('/breaks/start', { kind: 'EVENING' });
check('no break after End Day (409)', r.status === 409, r.body);
r = expectStatus('today says dayEnded', await staff.get('/breaks/me/today'), 200);
check('dayEnded true', r.body.data.dayEnded === true);

summary();
