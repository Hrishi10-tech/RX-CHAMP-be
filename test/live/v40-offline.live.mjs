// 4.0 offline replay: an agent offline for two hours sends its journal afterwards,
// oldest first, with X-Client-Event-Id and X-Event-At, then the activity samples it
// queued meanwhile (POST /activity/report, after the journal, as the agent does);
// the day comes out as it happened, and sending the whole journal again changes
// nothing. Without the samples the replayed time is "offline, no activity data".
// Self-contained: the org Admin of the seeded organisation creates a fresh Staff
// member for each run, so it needs nothing but a seeded database.
import { randomUUID } from 'node:crypto';
import { AGENT_40_UA, check, Client, summary } from './lib.mjs';

const data = (r) => r.body?.data;
/** JSON with sorted keys (stored bodies come back from jsonb with keys reordered). */
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
const RUN = Date.now().toString(36);
const PASS = 'Offline#2026x';

console.log('\n# A fresh Staff member (org Admin)');
const admin = await new Client('orgadmin').login('orgadmin@timechamp.test', 'orgadmin123');
const departments = data(await admin.get('/departments')) ?? [];
check('the organisation has a department', departments.length > 0, departments);
const email = `offline.${RUN}@timechamp.test`;
const created = await admin.post('/users', {
  firstName: 'Offline',
  lastName: `Agent ${RUN}`,
  email,
  password: PASS,
  role: 'USER',
  departmentId: departments[0]?.id,
});
check(`Staff ${email} created [201]`, created.status === 201, created.body);
const agent = await new Client('agent-4.0', AGENT_40_UA).login(email, PASS);
const N = Date.now();
const at = (min) => new Date(N - min * 60000).toISOString();

const journal = [
  { min: 120, method: 'POST', path: '/activity/start-day', body: {} },
  { min: 100, method: 'POST', path: '/breaks/quick/start', body: { plannedMin: 10 } },
  { min: 90, method: 'POST', path: '/breaks/end', body: {} },
  {
    min: 80,
    method: 'POST',
    path: '/away',
    body: { startedAt: at(85), reasonKey: 'THINKING', comment: 'Thinking through the design' },
  },
  {
    min: 60,
    method: 'POST',
    path: '/meetings/start',
    body: { agenda: 'Design review', participants: [{ name: 'Guest' }], momSender: 'Guest' },
  },
  { min: 45, method: 'POST', path: '/meetings/:id/end', body: {} },
  { min: 25, method: 'POST', path: '/away', body: { startedAt: at(35), reasonKey: 'BREAK' } },
  { min: 20, method: 'POST', path: '/breaks/end', body: {} },
].map((e) => ({ ...e, id: randomUUID() }));

async function send(e, meetingId) {
  const path = e.path.replace(':id', meetingId ?? 'x');
  return agent.req(e.method, path, e.body, { 'x-client-event-id': e.id, 'x-event-at': at(e.min) });
}

console.log('\n# Replay the journal');
let meetingId = null;
const first = [];
for (const e of journal) {
  const r = await send(e, meetingId);
  if (e.path === '/meetings/start') meetingId = data(r)?.meeting?.id;
  first.push(r);
  check(`${e.method} ${e.path} at -${e.min} min [${r.status}]`, r.status === 200, r.body);
}

const near = (sec, min) => Math.abs(sec - min * 60) <= 90;
let day = data(await agent.get('/workday/me/today'));
let f = day?.focus ?? {};
check(
  'the day started two hours ago',
  day?.startedAt && Math.abs(new Date(day.startedAt).getTime() - (N - 120 * 60000)) < 5000,
  day?.startedAt,
);
// Until the agent's activity arrives, the replayed time has no evidence: it is not focus.
check(
  'before the samples: the replayed span is offline with no activity data, not focus',
  f.unverifiedSec > 60 * 60 && f.focusSec < 5 * 60,
  f,
);

console.log('\n# Upload the activity queued while offline (after the journal, oldest first)');
// A sample every two minutes (the server credits each until the next, up to 150 s),
// idle while away, locked on the breaks: all of it is evidence the agent was running.
let stored = 0;
for (let min = 120; min >= 1; min -= min > 2 ? 2 : 1) {
  const away = min <= 85 && min > 80;
  const onBreak = (min <= 100 && min > 90) || (min <= 35 && min > 20);
  const r = await agent.post('/activity/report', {
    at: at(min),
    app: onBreak ? 'LockApp.exe' : 'Code.exe',
    title: 'design.md - Visual Studio Code',
    idle: away || onBreak,
    locked: onBreak,
  });
  if (r.status === 200) stored += 1;
}
check('every queued sample was taken (61 of them)', stored === 61, { stored });

day = data(await agent.get('/workday/me/today'));
f = day?.focus ?? {};
check('nothing left unverified once the activity is in', f.unverifiedSec <= 90, f);
// The away break runs from its start (-35, after the meeting ended at -45) to End break at -20.
check(
  'break time 25 min (quick 10 + away break 15)',
  near(f.breakSec, 25) && near(f.quickBreakSec, 25),
  f,
);
check('away pending 5 min', near(f.awayPendingSec, 5), f);
check('meeting 15 min', near(f.meetingSec, 15), f);
check('focus = span − breaks − pending away', near(f.focusSec, f.spanSec / 60 - 30), f);
check(
  'quick breaks are paid from the 10 min buffer only; the rest unpaid',
  near(f.paidBreakSec, 10) && near(f.unpaidBreakSec, 15),
  f,
);
check('paid time = focus + paid breaks', f.paidSec === f.focusSec + f.paidBreakSec, f);

console.log('\n# Send the whole journal again');
for (let i = 0; i < journal.length; i++) {
  const r = await send(journal[i], meetingId);
  check(
    `repeat ${journal[i].path} answers the stored result`,
    r.status === first[i].status && stable(r.body) === stable(first[i].body),
    { status: r.status },
  );
}
const again = data(await agent.get('/workday/me/today'));
check(
  'nothing doubled',
  again?.focus?.breakSec === f.breakSec && again?.focus?.awayPendingSec === f.awayPendingSec,
  again?.focus,
);

const h = data(await agent.get('/workday/me/history'));
check(
  'History shows the replayed meeting with its MoM sender',
  h?.meetings?.some((m) => m.agenda === 'Design review' && m.momSender === 'Guest'),
  h?.meetings,
);
const hd = h?.days?.find((d) => d.date === day?.date);
check(
  'History carries paid and unverified time for the day',
  hd && hd.paidSec === hd.focusSec + hd.paidBreakSec && hd.unverifiedSec <= 90,
  hd,
);
const r = await agent.req(
  'POST',
  '/activity/end-day',
  {},
  { 'x-client-event-id': randomUUID(), 'x-event-at': new Date().toISOString() },
);
check('End Day (live)', r.status === 200, r.body);
summary();
