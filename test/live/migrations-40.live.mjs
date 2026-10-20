// The three 4.0 migrations on 3.1-shaped data, applied by Prisma the way a deployment does
// (docs/4.0/DEPLOY.md 6.5). For each scenario it builds a scratch database next to the local
// one (localhost only), applies every migration up to 20261014_focus_meetings_reports_backfill
// (production 3.1), writes 3.1 rows for every backfill case, applies 20261020_v40_1_enums,
// 20261020_v40_2_orgs and 20261020_v40_3_backfill one at a time with `prisma migrate deploy`
// (timed), checks the invariants and the runbook's before/after queries (DEPLOY.md 4.3 to 4.5
// and 6.6, read from the runbook itself), runs the backfill file a second time with psql inside
// one transaction (nothing may change), boots the built API on the result for a few reads, and
// drops the scratch database, also on failure.
//
//   Scenario A: one company (production's shape). Scenario B: two companies (DEPLOY.md 0.2).
//
//   node test/live/migrations-40.live.mjs     both scenarios; build the API first (npx nest build)
//   SCENARIO=A (or B)                          one scenario
//   BOOT=0                                     skip the API boot check
//   VOLUME=5                                   adds 5 x 100k activity samples and six months of 3.1
//                                              sessions, breaks and meetings for 200 people, and
//                                              prints each migration's duration
//   MIG40_PORT=4700                            the port of the API it starts (never 4000, 4200-4600)
//
// DATABASE_URL (environment, else backend/.env) only locates the local cluster: the scratch
// databases are created through its `postgres` maintenance database, the default database is
// never opened. No secret is printed.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDatabaseUrl } from './db.mjs';

const PORT = Number(process.env.MIG40_PORT ?? 4700);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT === 4000 || (PORT >= 4200 && PORT <= 4600)) {
  console.error(`Refusing port ${process.env.MIG40_PORT}: pick a free port outside 4000 and 4200-4600.`);
  process.exit(2);
}
process.env.API = `http://localhost:${PORT}/api/v1`;
const { check, Client, summary } = await import('./lib.mjs');
const { PrismaClient } = await import('@prisma/client');

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', '..');
const MIGRATIONS = join(BACKEND, 'prisma', 'migrations');
const PRISMA_BIN = join(BACKEND, 'node_modules', '.bin', 'prisma');
const DEPLOY_MD = join(BACKEND, '..', 'docs', '4.0', 'DEPLOY.md');
const LAST_31 = '20261014_focus_meetings_reports_backfill';
const V40 = ['20261020_v40_1_enums', '20261020_v40_2_orgs', '20261020_v40_3_backfill'];
const BACKFILL_SQL = join(MIGRATIONS, V40[2], 'migration.sql');
const VOLUME = Number(process.env.VOLUME ?? 0);
const BOOT = process.env.BOOT !== '0';
const SCENARIOS = (process.env.SCENARIO ?? 'A,B').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
const RESERVED = new Set(['rxv_lead', 'rxv_portal_int', 'rxv_agent_e2e', 'rxv_fix', 'rxv_audit', 'rxv_people', 'postgres', 'template0', 'template1']);

// ---- Local cluster -----------------------------------------------------------------
const BASE = new URL(localDatabaseUrl()); // exits unless DATABASE_URL is on localhost
const BASE_DB = decodeURIComponent(BASE.pathname.replace(/^\//, ''));
const SCHEMA = BASE.searchParams.get('schema') ?? 'public';
const urlOf = (name) => {
  const u = new URL(BASE);
  u.pathname = `/${name}`;
  return u.toString();
};
const pgEnv = (name) => ({
  PGHOST: BASE.hostname.replace(/^\[|\]$/g, ''),
  PGPORT: BASE.port || '5432',
  PGUSER: decodeURIComponent(BASE.username),
  PGPASSWORD: decodeURIComponent(BASE.password),
  PGDATABASE: name,
  PGOPTIONS: `-c search_path=${SCHEMA}`,
  ...(BASE.searchParams.get('sslmode') ? { PGSSLMODE: BASE.searchParams.get('sslmode') } : {}),
});
/** Never print a connection string with its credentials. */
const scrub = (s) => String(s ?? '').replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, '$1***@');

function psql(name, args, input) {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
    env: { ...process.env, ...pgEnv(name) },
    input,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`psql on ${name} failed: ${scrub(r.stderr || r.error?.message)}`);
  return r.stdout;
}
/** Runs a SQL text in one transaction. */
function psqlText(name, text, work) {
  const file = join(work, `sql-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(file, text);
  return psql(name, ['--single-transaction', '-f', file]);
}

// Scratch databases, temporary folders and the API child, cleaned up on every exit path.
const live = { dbs: new Set(), dirs: new Set(), api: null };
function dropDb(name) {
  try {
    psql('postgres', [
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      '-c', `DROP DATABASE IF EXISTS "${name}"`,
    ]);
    live.dbs.delete(name);
  } catch (e) {
    console.error(`  could not drop ${name}: ${scrub(e.message)}`);
  }
}
function cleanupNow() {
  if (live.api && live.api.exitCode === null) live.api.kill('SIGKILL');
  for (const name of [...live.dbs]) dropDb(name);
  for (const dir of live.dirs) rmSync(dir, { recursive: true, force: true });
  live.dirs.clear();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`\n${sig}: cleaning up`);
    cleanupNow();
    process.exit(130);
  });
}

// ---- Time and ids -------------------------------------------------------------------
const TZ = 'Asia/Kolkata';
const dayKey = (at) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const ist = (date, hm) => new Date(`${date}T${hm}:00+05:30`);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
};
const monthDates = (m) => {
  const out = [];
  for (let d = `${m}-01`; d.startsWith(m); d = addDays(d, 1)) out.push(d);
  return out;
};
const workdays = (m) => monthDates(m).filter((d) => weekday(d) !== 0);
const NOW = new Date();
const TODAY = dayKey(NOW);
const CM = TODAY.slice(0, 7);
const LM = prevMonth(CM);
const LLM = prevMonth(LM);
const L3M = prevMonth(LLM);
/** The last Monday-to-Saturday day before today. */
const RECENT = (() => {
  let d = addDays(TODAY, -1);
  while (weekday(d) === 0) d = addDays(d, -1);
  return d;
})();
const RECENT2 = (() => {
  let d = addDays(RECENT, -1);
  while (weekday(d) === 0) d = addDays(d, -1);
  return d;
})();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);
const md5 = (s) => createHash('md5').update(s).digest('hex');
/** What PostgreSQL's md5(text)::uuid gives. */
const md5uuid = (s) => {
  const h = md5(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const uid = (tag) => md5uuid(`mig40:${tag}`);

// The app's own department key (department.rules departmentNameKey, shifts departmentKey).
const tidy = (s) => (s ?? '').trim().replace(/\s+/g, ' ');
const deptKey = (s) => tidy(s).toLowerCase() || null;

/** The icon table of DEPLOY.md 6.5 (first match wins, on the lower-case name). */
function iconFor(key) {
  const rules = [
    [/(electronic|hardware|pcb|embedded)/, 'circuit-board'],
    [/(engineer|develop|software|tech|\bit\b)/, 'code'],
    [/(r&d|r & d|research)/, 'flask'],
    [/(quality|\bqa\b|qms)/, 'badge-check'],
    [/(regulat|compliance|legal)/, 'scale'],
    [/(sales|business)/, 'bar-chart'],
    [/market/, 'megaphone'],
    [/(support|service|customer)/, 'headphones'],
    [/(\bhr\b|human|people|talent)/, 'users'],
    [/(financ|account)/, 'wallet'],
    [/(design|creative)/, 'palette'],
    [/(production|manufactur|assembly)/, 'factory'],
    [/(procure|purchas|inventory|store|warehouse)/, 'boxes'],
    [/(logistic|dispatch|shipping)/, 'truck'],
    [/(clinical|medical|health)/, 'stethoscope'],
    [/(operation|admin)/, 'settings'],
  ];
  return rules.find(([re]) => re.test(key))?.[1] ?? 'briefcase';
}

// ---- SQL text helpers ------------------------------------------------------------------
const raw = (sql) => ({ raw: sql });
const ROLE = (name) => raw(`(SELECT id FROM roles WHERE name = '${name}')`);
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v.raw !== undefined) return v.raw;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 23).replace('T', ' ')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const jsonb = (o) => raw(`${lit(JSON.stringify(o))}::jsonb`);
function insert(table, rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES\n${rows
    .map((r) => `  (${cols.map((c) => lit(r[c])).join(', ')})`)
    .join(',\n')};\n`;
}

// =====================================================================================
// The 3.1 data
// =====================================================================================

/** S1's working days last month: a normal day and every variation the focus formula knows. */
const NORMAL = [['MORNING', '11:00', '11:15', 15], ['LUNCH', '13:00', '13:30', 30], ['EVENING', '16:00', '16:15', 15]];
const S1_DAYS = [
  { label: 'a normal day', breaks: NORMAL },
  { label: 'lunch 12 min over, not asked', breaks: [NORMAL[0], ['LUNCH', '13:00', '13:42', 30], NORMAL[2]] },
  { label: 'morning skipped, approved', breaks: [NORMAL[1], NORMAL[2]], skip: ['MORNING', '11:00', 15, 'APPROVED'] },
  { label: 'lunch 15 min over, asked and approved', breaks: [NORMAL[0], ['LUNCH', '13:00', '13:45', 30, 'APPROVED'], NORMAL[2]] },
  { label: 'a past meeting, approved', breaks: NORMAL, meeting: ['14:00', '14:30', 'APPROVED'] },
  { label: 'a normal day', breaks: NORMAL },
  { label: 'evening skipped, rejected', breaks: [NORMAL[0], NORMAL[1]], skip: ['EVENING', '16:00', 15, 'REJECTED'] },
  { label: 'a past meeting, rejected', breaks: NORMAL, meeting: ['15:00', '15:20', 'REJECTED'] },
];
const S1_LOCKED_DAYS = 3; // normal days in the month before, which 3.1 locked
const BUFFER_MIN = 10; // 4.0 default: the 3.1 settings row has no breakBufferMin

/** 3.1 focus (and 4.0's paid and unpaid split) of one S1 day, from the spec above. */
function s1Expect(spec) {
  const min = (a, b) => (Date.parse(`2000-01-01T${b}:00Z`) - Date.parse(`2000-01-01T${a}:00Z`)) / 1000;
  const span = min('09:30', '18:30');
  let breakSec = 0;
  let plus = 0;
  let minus = 0;
  let paidSched = 0;
  let overrun = 0;
  for (const [, s, e, dur, asked] of spec.breaks) {
    const taken = min(s, e);
    breakSec += taken;
    paidSched += Math.min(taken, dur * 60);
    overrun += Math.max(0, taken - dur * 60);
    if (asked === 'APPROVED') plus += Math.max(0, taken - dur * 60);
  }
  if (spec.skip?.[3] === 'REJECTED') minus += spec.skip[2] * 60;
  if (spec.meeting?.[2] === 'REJECTED') minus += min(spec.meeting[0], spec.meeting[1]);
  const paid = Math.min(breakSec, paidSched + Math.min(BUFFER_MIN * 60, overrun));
  return { focusSec: Math.max(0, span - breakSec + plus - minus), breakSec, paidBreakSec: paid, unpaidBreakSec: breakSec - paid };
}

function buildFixture(sc) {
  const two = sc === 'B';
  const sql = [];
  const C = { c0: uid('company:c0'), c1: uid('company:c1'), c2: uid('company:c2') };
  const companies = [
    { id: C.c0, name: 'Old Pilot Co', created_at: daysAgo(500), updated_at: daysAgo(300), deleted_at: daysAgo(300) },
    { id: C.c1, name: 'Northwind Devices', created_at: daysAgo(400), updated_at: daysAgo(400), deleted_at: null },
    ...(two ? [{ id: C.c2, name: 'Southwind Labs', created_at: daysAgo(200), updated_at: daysAgo(200), deleted_at: null }] : []),
  ];
  sql.push(insert('companies', companies));

  // tag, role, department text, 3.1 manager, company in A, company in B, extra
  const P = (tag, role, dept, mgr, compA, compB, extra = {}) => ({ tag, role, dept, mgr, comp: two ? compB : compA, ...extra });
  const people = [
    P('sa1', 'SUPER_ADMIN', 'Management', null, 'c1', 'c1'),
    P('sa2', 'SUPER_ADMIN', null, null, null, null),
    P('m1', 'MANAGER', 'R&D', null, 'c1', 'c1'),
    P('m2', 'MANAGER', null, null, 'c1', 'c2'),
    P('m3', 'MANAGER', '  Quality   Assurance ', null, 'c1', 'c1'),
    P('m4', 'MANAGER', null, null, 'c1', 'c1'),
    P('m5', 'MANAGER', 'Logistics', null, 'c1', 'c1', { deleted: true }),
    P('m6', 'MANAGER', 'Support', null, null, null),
    P('m7', 'MANAGER', 'Sales', null, 'c1', 'c2', { status: 'DISABLED' }),
    P('s1', 'USER', 'R&D', 'm1', 'c1', 'c1'),
    P('s2', 'USER', 'r&d  ', 'm1', 'c1', 'c1'),
    P('s3', 'USER', 'Electronics', 'm1', 'c1', 'c1'),
    P('s4', 'USER', 'Sales', 'm2', 'c1', 'c2'),
    P('s5', 'USER', ' sales', 'm2', 'c1', 'c2'),
    P('s6', 'USER', null, 'm2', 'c1', 'c2'),
    P('s7', 'USER', '', null, 'c1', 'c1'),
    P('s8', 'USER', '   ', 'm1', 'c1', 'c1'),
    P('s9', 'USER', 'support ', 'm6', null, null),
    P('s10', 'USER', 'Logistics', 'm5', 'c1', 'c1', { deleted: true }),
    P('s11', 'USER', 'Sales', 'm2', 'c1', 'c2', { deleted: true }),
    P('s12', 'USER', 'Field   Service', null, 'c1', 'c1'),
    P('s13', 'USER', 'field service', 'm5', 'c1', 'c1'),
    P('s14', 'USER', 'SALES', 'm7', 'c1', 'c2', { status: 'DISABLED' }),
    P('s15', 'USER', 'Sales\t', 'm2', 'c1', 'c2'), // legacy text with a trailing tab
    P('s16', 'USER', null, null, null, null),
    P('s17', 'USER', 'R&D', 'sa1', 'c1', 'c1'), // 3.1 manager is a Super Admin
    P('s18', 'USER', 'Sales', 'm1', 'c1', 'c1'),
    P('s19', 'USER', 'Electronics', 'm1', 'c1', 'c2'), // B: manager in the other company
    P('s20', 'USER', 'Support', null, 'c1', 'c1'),
    P('x0', 'USER', 'Pilot', null, 'c0', 'c0', { deleted: true }), // member of the deleted company
  ];
  const U = Object.fromEntries(people.map((p) => [p.tag, uid(`user:${p.tag}`)]));
  const S = { gen: uid('shift:gen'), night: uid('shift:night'), lab: uid('shift:lab'), old: uid('shift:old'), c2day: uid('shift:c2day') };
  const label = { SUPER_ADMIN: 'Super', MANAGER: 'Manager', USER: 'Staff' };
  sql.push(insert('users', people.map((p, i) => ({
    id: U[p.tag],
    email: `${p.tag}@mig40.test`,
    password_hash: '$2b$12$mig40.fixture.no.password.can.match.this.hash.xxxxxxxx',
    first_name: label[p.role],
    last_name: p.tag.toUpperCase(),
    designation: null,
    department: p.dept,
    status: p.status ?? 'ACTIVE',
    role_id: ROLE(p.role),
    company_id: p.comp ? C[p.comp] : null,
    shift_id: null, // set below, once the shifts exist
    agent_activated_at: p.role === 'USER' ? daysAgo(150) : null,
    created_at: daysAgo(300 - i),
    updated_at: daysAgo(100 - i),
    deleted_at: p.deleted ? daysAgo(40) : null,
    screenshots_enabled: p.tag !== 's7',
  }))));
  for (const p of people.filter((x) => x.mgr)) {
    sql.push(`UPDATE users SET manager_id = '${U[p.mgr]}' WHERE id = '${U[p.tag]}';`);
  }

  // ---- Shifts (3.0 and 3.1 rules) ----------------------------------------------------
  const shift = (key, company, name, start, end, isDefault, deleted = null) => ({
    id: S[key], company_id: company, name, start, end, created_at: daysAgo(250), updated_at: daysAgo(120),
    deleted_at: deleted, is_default: isDefault, overrun_grace_min: 3, overrun_reason: true, reason_min_chars: 10,
    reason_on_early: true, reason_on_late: true, ring_duration_min: 5, ring_lead_min: 1, ring_sound: true,
    work_days: raw('ARRAY[1,2,3,4,5,6]::int[]'),
  });
  sql.push(insert('shifts', [
    shift('gen', null, 'General', '09:30', '18:30', true),
    shift('night', null, 'Night', '21:00', '06:00', false),
    shift('lab', C.c1, 'Lab', '08:00', '17:00', false),
    shift('old', null, 'Old', '10:00', '19:00', false, daysAgo(60)),
    ...(two ? [shift('c2day', C.c2, 'C2 Day', '10:00', '19:00', true)] : []),
  ]));
  const brk = (sh, kind, start, dur, allowSkip = true) => ({
    id: uid(`shiftbreak:${sh}:${kind}`), shift_id: S[sh], kind, enabled: true, start_time: start, duration_min: dur,
    window_before_min: 30, window_after_min: 60, created_at: daysAgo(250), updated_at: daysAgo(120), allow_skip: allowSkip,
  });
  sql.push(insert('shift_breaks', [
    brk('gen', 'MORNING', '11:00', 15), brk('gen', 'LUNCH', '13:00', 30, false), brk('gen', 'EVENING', '16:00', 15),
    brk('night', 'LUNCH', '01:00', 30, false), brk('lab', 'MORNING', '10:00', 15), brk('old', 'MORNING', '10:30', 10),
    ...(two ? [brk('c2day', 'LUNCH', '14:00', 30, false)] : []),
  ]));
  // The legacy users.shift_id (3.0 carried it into USER assignments; nothing reads it now).
  sql.push(`UPDATE users SET shift_id = '${S.gen}' WHERE id = '${U.s1}';`, `UPDATE users SET shift_id = '${S.lab}' WHERE id = '${U.s3}';`);
  const A = {};
  const asg = (key, target, company, dept, user, sh, from, to = null, age = 100) => {
    A[key] = uid(`assign:${key}`);
    return {
      id: A[key], target, company_id: company, department: dept, department_key: deptKey(dept), user_id: user ? U[user] : null,
      shift_id: sh ? S[sh] : null, effective_from: from, effective_to: to, created_by_id: U.sa1, created_at: daysAgo(age),
    };
  };
  sql.push(insert('shift_assignments', [
    asg('a1', 'DEPARTMENT', null, 'Sales', null, 'gen', '2026-01-01', null, 200),
    asg('a2', 'DEPARTMENT', null, 'Electronics', null, 'night', '2026-03-01', null, 190),
    asg('a3', 'USER', null, null, 's9', 'gen', '2000-01-01', null, 180), // 3.0 carry-over, no company then
    asg('a4', 'USER', C.c1, null, 's3', 'lab', '2000-01-01', null, 180),
    asg('a5', 'USER', null, null, 's4', null, `${LM}-01`, null, 50), // back to the department's shift
    asg('a6', 'DEPARTMENT', C.c1, 'R&D', null, 'gen', '2026-06-01', null, 140),
    asg('a7', 'DEPARTMENT', null, 'Field Service', null, 'old', '2026-01-01', '2026-05-31', 210), // ended, deleted shift
    asg('a8', 'USER', C.c1, null, 's2', 'night', addDays(`${LM}-01`, 14), null, 40),
    asg('a9a', 'DEPARTMENT', null, 'Support', null, 'night', '2026-02-01', null, 230),
    asg('a9', 'DEPARTMENT', null, 'Support', null, null, '2026-07-01', null, 110), // "no department shift" from July
    asg('a10', 'USER', null, null, 's5', 'night', addDays(`${LM}-01`, 9), null, 45),
  ]));

  // ---- Settings, locks and runs ----------------------------------------------------------
  const org31 = {
    approvalSlaHours: 36, blockManagerEndDayWhenOverdue: false, fullDayPct: 75, halfDayPct: 45,
    lateStartGraceMin: 15, quietHourActiveMin: 25, quietHoursFlag: 6, autoCloseAfterShiftEndMin: 180,
  };
  const firstBoot = new Date(Math.min(ist(addDays(`${CM}-01`, 13), '07:20').getTime(), ist(RECENT2, '07:20').getTime()));
  sql.push(insert('app_settings', [
    { key: 'org', value: jsonb(org31), updated_by_id: U.sa1, updated_at: daysAgo(3) },
    { key: 'system', value: jsonb({ firstBootAt: firstBoot.toISOString() }), updated_at: firstBoot },
  ]));

  // ---- S1's history: sessions, breaks, meetings, samples ------------------------------------
  const rows = { work_day_ends: [], work_sessions: [], presence_sessions: [], break_records: [], meeting_records: [], activity_samples: [] };
  const s1Expected = [];
  const day = (user, date, start = '09:30', end = '18:30', open = false) => {
    rows.work_day_ends.push({ id: uid(`wde:${user}:${date}`), user_id: U[user], date, ended_at: open ? null : ist(date, end), created_at: ist(date, start), login_at: ist(date, start) });
    rows.work_sessions.push({
      id: uid(`ws:${user}:${date}`), user_id: U[user], date, started_at: ist(date, start), ended_at: open ? null : ist(date, end),
      end_reason: open ? null : raw(`'USER'::"WorkSessionEndReason"`), source: 'AGENT', created_at: ist(date, start), updated_at: open ? ist(date, start) : ist(date, end),
    });
  };
  const presence = (key, user, type, date, start, end) => {
    const id = uid(`ps:${key}`);
    rows.presence_sessions.push({
      id, user_id: U[user], device_id: null, type, note: null, date, started_at: start, ended_at: end,
      duration_sec: end ? Math.round((end - start) / 1000) : null, created_at: start, updated_at: end ?? start,
    });
    return id;
  };
  const B = {};
  /** A 3.1 break record (and, when taken, its presence session). */
  const breakRec = (key, user, date, kind, o) => {
    const sched = ist(date, o.sched ?? { MORNING: '11:00', LUNCH: '13:00', EVENING: '16:00' }[kind]);
    const start = o.start ? ist(date, o.start) : (o.startAt ?? sched);
    const end = o.end === null ? null : o.end ? ist(date, o.end) : null;
    const taken = (o.outcome ?? 'TAKEN') === 'TAKEN';
    const ps = taken ? presence(key, user, kind === 'LUNCH' ? 'LUNCH' : 'BREAK', date, start, end) : null;
    B[key] = uid(`br:${key}`);
    const status = o.status ?? 'NOT_REQUIRED';
    rows.break_records.push({
      id: B[key], user_id: U[user], date, kind: raw(`'${kind}'::"BreakKind"`), seq: 0, presence_type: raw(`'${kind === 'LUNCH' ? 'LUNCH' : 'BREAK'}'::"PresenceType"`),
      shift_id: S.gen, shift_name: 'General', scheduled_start: sched, duration_min: o.dur,
      window_open: new Date(sched.getTime() - 30 * 60_000), window_close: new Date(sched.getTime() + 60 * 60_000),
      ring_start: new Date(sched.getTime() - 60_000), ring_end: new Date(sched.getTime() + 4 * 60_000),
      presence_session_id: ps, started_at: start, timing: raw(`'${o.timing ?? 'ON_TIME'}'::"BreakTiming"`), minutes_off: o.minutesOff ?? 0,
      reason: o.reason ?? null, overrun_reason: o.overrunReason ?? null, source: o.source ?? 'AGENT',
      approval_status: raw(`'${status}'::"BreakApprovalStatus"`), approver_role: o.role ? raw(`'${o.role}'::"RoleName"`) : null,
      approver_id: o.approver ? U[o.approver] : null, decided_by_id: o.decidedBy ? U[o.decidedBy] : null,
      decided_at: o.decidedBy ? new Date(start.getTime() + 3 * 3_600_000) : null, decision_note: null,
      created_at: start, updated_at: end ?? start, commented_at: null,
      due_at: status === 'PENDING' ? new Date(start.getTime() + 48 * 3_600_000) : null, escalated_at: null,
      outcome: raw(`'${o.outcome ?? 'TAKEN'}'::"BreakOutcome"`), overrun_asked: !!o.overrunSec, overrun_sec: o.overrunSec ?? null, reminded_at: null,
    });
  };
  const M = {};
  const meetingRec = (key, user, date, mode, start, end, o) => {
    const s = ist(date, start);
    const e = ist(date, end);
    const ps = mode === 'LIVE' ? presence(key, user, 'MEETING', date, s, e) : null;
    M[key] = uid(`mr:${key}`);
    const status = o.status;
    rows.meeting_records.push({
      id: M[key], user_id: U[user], date, mode: raw(`'${mode}'::"MeetingMode"`), agenda: o.agenda ?? 'Supplier review',
      participants: jsonb(o.participants ?? [{ name: 'Vendor team' }]), started_at: s, ended_at: e, duration_sec: Math.round((e - s) / 1000),
      presence_session_id: ps, approval_status: raw(`'${status}'::"BreakApprovalStatus"`), approver_role: raw(`'${o.role}'::"RoleName"`),
      approver_id: o.approver ? U[o.approver] : null, decided_by_id: o.decidedBy ? U[o.decidedBy] : null,
      decided_at: o.decidedBy ? new Date(e.getTime() + 3_600_000) : null, decision_note: null,
      due_at: status === 'PENDING' ? new Date(e.getTime() + 48 * 3_600_000) : null, escalated_at: null, reminded_at: null,
      created_at: e, updated_at: e,
    });
  };
  const sample = (user, date, hm, app) =>
    rows.activity_samples.push({ id: uid(`as:${user}:${date}:${hm}`), user_id: U[user], device_id: uid('device:s1'), date, at: ist(date, hm), duration_sec: 60, idle: false, locked: false, app, title: 'Board bring-up notes', url: null, created_at: ist(date, hm) });

  const s1Days = workdays(LM).slice(0, S1_DAYS.length);
  S1_DAYS.forEach((spec, i) => {
    const date = s1Days[i];
    day('s1', date);
    for (const [kind, s, e, dur, asked] of spec.breaks) {
      breakRec(`s1:${date}:${kind}`, 's1', date, kind, {
        start: s, end: e, dur,
        ...(asked ? { overrunReason: 'Supplier call ran over', overrunSec: ((Date.parse(`2000-01-01T${e}:00Z`) - Date.parse(`2000-01-01T${s}:00Z`)) / 1000) - dur * 60, status: asked, role: 'MANAGER', approver: 'm1', decidedBy: 'm1' } : {}),
      });
    }
    if (spec.skip) {
      const [kind, hm, dur, status] = spec.skip;
      breakRec(`s1:${date}:${kind}`, 's1', date, kind, { start: hm, end: null, dur, outcome: 'SKIPPED', reason: 'Prototype test running', status, role: 'MANAGER', approver: 'm1', decidedBy: 'm1' });
    }
    if (spec.meeting) {
      const [s, e, status] = spec.meeting;
      meetingRec(`s1:${date}`, 's1', date, 'PAST', s, e, { status, role: 'MANAGER', approver: 'm1', decidedBy: 'm1' });
    }
    sample('s1', date, '09:45', 'KiCad'); sample('s1', date, '12:10', 'EXCEL.EXE'); sample('s1', date, '17:30', 'chrome.exe');
    s1Expected.push({ date, label: spec.label, ...s1Expect(spec) });
  });
  const lockedDays = workdays(LLM).slice(0, S1_LOCKED_DAYS);
  for (const date of lockedDays) {
    day('s1', date);
    for (const [kind, s, e, dur] of NORMAL) breakRec(`s1:${date}:${kind}`, 's1', date, kind, { start: s, end: e, dur });
  }

  // ---- Approval items in every pool -----------------------------------------------------------
  breakRec('pendSaStaff', 's17', RECENT, 'LUNCH', { start: '13:00', end: '13:40', dur: 30, overrunReason: 'Customer escalation', overrunSec: 600, status: 'PENDING', role: 'SUPER_ADMIN', approver: 'sa1' });
  breakRec('pendSaMgr', 'm1', RECENT, 'MORNING', { start: '11:20', end: '11:35', dur: 15, timing: 'LATE', minutesOff: 20, reason: 'Lab handover with the night team', status: 'PENDING', role: 'SUPER_ADMIN' });
  breakRec('pendMgr', 's2', RECENT, 'MORNING', { start: '10:20', end: '10:35', dur: 15, timing: 'EARLY', minutesOff: 40, reason: 'Soldering station free early', status: 'PENDING', role: 'MANAGER', approver: 'm1' });
  breakRec('skipPendSa', 'm3', RECENT, 'MORNING', { start: '11:00', end: null, dur: 15, outcome: 'SKIPPED', reason: 'Audit preparation all morning', status: 'PENDING', role: 'SUPER_ADMIN' });
  breakRec('skipPendMgr', 's4', RECENT, 'EVENING', { start: '16:00', end: null, dur: 15, outcome: 'SKIPPED', reason: 'Closing the month-end orders', status: 'PENDING', role: 'MANAGER', approver: 'm2' });
  breakRec('autoSkipPend', 's6', RECENT, 'LUNCH', { start: '13:00', end: null, dur: 30, outcome: 'AUTO_SKIPPED', source: 'SYSTEM', status: 'PENDING', role: 'MANAGER', approver: 'm2' });
  breakRec('apprSa', 'm2', RECENT2, 'LUNCH', { start: '13:00', end: '13:50', dur: 30, overrunReason: 'Distributor visit', overrunSec: 1200, status: 'APPROVED', role: 'SUPER_ADMIN', decidedBy: 'sa1' });
  breakRec('rejMgr', 's3', RECENT2, 'EVENING', { start: '16:40', end: '16:55', dur: 15, timing: 'LATE', minutesOff: 40, reason: 'Was on the line', status: 'REJECTED', role: 'MANAGER', approver: 'm1', decidedBy: 'm1' });
  breakRec('pendSaNoOrg', 's16', RECENT, 'MORNING', { start: '10:25', end: '10:40', dur: 15, timing: 'EARLY', minutesOff: 35, reason: 'Courier arrived early', status: 'PENDING', role: 'SUPER_ADMIN' });
  breakRec('pendMgrNoOrg', 's9', RECENT, 'MORNING', { start: '11:30', end: '11:45', dur: 15, timing: 'LATE', minutesOff: 30, reason: 'Customer call on the hotline', status: 'PENDING', role: 'MANAGER', approver: 'm6' });
  // Somebody on a break while 3.1 stops (or a break left open): an open segment, state ACTIVE.
  const midnight = ist(TODAY, '00:00');
  const hhmm = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const openStart = new Date(Math.max(midnight.getTime(), NOW.getTime() - 2 * 3_600_000));
  day('s4', TODAY, hhmm(openStart), null, true);
  breakRec('openBreak', 's4', TODAY, 'MORNING', { startAt: new Date(Math.max(openStart.getTime(), NOW.getTime() - 20 * 60_000)), end: null, dur: 15, timing: 'UNSCHEDULED', outcome: 'TAKEN' });
  meetingRec('mPendSa', 'm1', RECENT, 'LIVE', '15:00', '15:30', { status: 'PENDING', role: 'SUPER_ADMIN' });
  meetingRec('mPendMgr', 's1', RECENT, 'PAST', '16:30', '17:00', { status: 'PENDING', role: 'MANAGER', approver: 'm1' });
  meetingRec('mApprSa', 'm2', RECENT2, 'PAST', '12:00', '12:45', { status: 'APPROVED', role: 'SUPER_ADMIN', decidedBy: 'sa1' });
  meetingRec('mRejMgr', 's2', RECENT2, 'PAST', '14:00', '14:20', { status: 'REJECTED', role: 'MANAGER', approver: 'm1', decidedBy: 'm1' });

  for (const t of ['work_day_ends', 'work_sessions', 'presence_sessions', 'break_records', 'meeting_records']) sql.push(insert(t, rows[t]));

  // ---- Month locks and report runs (3.1 keys) ----------------------------------------------------
  const s1Person = { id: U.s1, name: 'Staff S1', email: 's1@mig40.test', role: 'USER', department: 'R&D', designation: null, managerId: U.m1, managerName: 'Manager M1' };
  const lockedFocus = S1_LOCKED_DAYS * 8 * 3600;
  const snapshot31 = (month, worked, lockedAt) => {
    const generatedAt = lockedAt.toISOString();
    const days = monthDates(month).map((date) => {
      const w = worked.includes(date);
      const wd = weekday(date) !== 0;
      return {
        date, weekday: weekday(date) === 0 ? 7 : weekday(date), workday: wd, dayClass: w ? 'FULL' : wd ? 'ABSENT' : 'OFF',
        startedAt: w ? ist(date, '09:30').toISOString() : null, endedAt: w ? ist(date, '18:30').toISOString() : null, autoClosed: false,
        lateStart: null, focusSec: w ? 28800 : 0, expectedSec: wd ? 28800 : 0, breakSec: w ? 3600 : 0, meetingSec: 0,
        approvedPlusSec: 0, rejectedMinusSec: 0, pendingPlusSec: 0, pendingMinusSec: 0, breaksTaken: w ? 3 : 0, skipped: 0,
        autoSkipped: 0, overruns: 0, meetings: 0, pending: 0, quietHours: 0, activeMin: w ? 410 : 0,
      };
    });
    const wdays = days.filter((d) => d.workday).length;
    const focus = days.reduce((s, d) => s + d.focusSec, 0);
    const totals = {
      workdays: wdays, full: worked.length, half: 0, absent: wdays - worked.length, off: days.length - wdays, extra: 0,
      focusSec: focus, expectedSec: wdays * 28800, avgFocusSec: worked.length ? Math.round(focus / worked.length) : 0,
      lateStarts: 0, skipped: 0, autoSkipped: 0, overruns: 0, meetings: 0, approvedPlusSec: 0, rejectedMinusSec: 0, pending: 0,
      quietHours: 0, needsALook: false,
    };
    const person = { person: s1Person, month, locked: true, generatedAt, totals, days, heatmap: [] };
    return {
      version: 1, generatedAt,
      team: { month, scope: 'ALL', locked: true, generatedAt, totals: { ...totals, people: 1 }, rows: [{ person: s1Person, totals, days: days.map((d) => ({ date: d.date, dayClass: d.dayClass, focusSec: d.focusSec })) }] },
      persons: { [U.s1]: person },
    };
  };
  const lockAt = { [L3M]: ist(`${LLM}-03`, '10:00'), [LLM]: ist(`${LM}-02`, '10:00') };
  sql.push(insert('month_locks', [
    { month: L3M, locked_by_id: U.sa1, locked_at: lockAt[L3M], snapshot: jsonb(snapshot31(L3M, [], lockAt[L3M])) },
    { month: LLM, locked_by_id: U.sa1, locked_at: lockAt[LLM], snapshot: jsonb(snapshot31(LLM, lockedDays, lockAt[LLM])) },
  ]));
  const run = (key, month, scope, owner, people) => ({
    id: uid(`run:${key}`), month, scope, owner_id: U[owner], generated_at: ist(`${month === LM ? CM : LM}-01`, '00:30'),
    summary: jsonb({ people, focusSec: people * 160 * 3600, full: people * 20, half: 1, absent: 0, needsALook: 0 }),
  });
  const R = { allLLM: uid('run:allLLM'), teamM1: uid('run:teamM1'), teamM2: uid('run:teamM2'), allLM: uid('run:allLM') };
  sql.push(insert('report_runs', [
    run('allLLM', LLM, 'ALL', 'sa1', 24), run('teamM1', LLM, 'TEAM', 'm1', 8), run('teamM2', LLM, 'TEAM', 'm2', 5), run('allLM', LM, 'ALL', 'sa1', 25),
  ]));

  // ---- Tables 4.0 never touches -------------------------------------------------------------------
  const d0 = s1Days[0];
  const d1 = s1Days[1];
  sql.push(insert('devices', [{ id: uid('device:s1'), device_token: md5('device-token-s1'), hostname: 'LAB-PC-07', username: 'staff', display_name: 'Lab PC 7', agent_version: '3.1.0', user_id: U.s1, paired_at: daysAgo(150), last_seen: daysAgo(1), last_stats: jsonb({ cpu: 12 }), created_at: daysAgo(150), updated_at: daysAgo(1), deleted_at: null }]));
  sql.push(insert('activity_samples', rows.activity_samples));
  sql.push(insert('daily_reports', [d0, d1].map((d) => ({ id: uid(`dr:${d}`), date: d, device_id: uid('device:s1'), user_id: U.s1, name: 'Staff S1', hostname: 'LAB-PC-07', total_sec: 32400, active_sec: 27000, idle_sec: 5400, productive_sec: 25000, extra_sec: 0, working_basis_sec: 28800, top_apps: jsonb([{ app: 'KiCad', sec: 9000 }]), top_websites: null, hourly: null, idle_blocks: null, clock_in_ms: ist(d, '09:30').getTime(), out_ms: ist(d, '18:30').getTime(), clocked_out: true, created_at: ist(d, '18:30'), updated_at: ist(d, '18:30') }))));
  sql.push(insert('online_sessions', [d0, d1].map((d) => ({ id: uid(`os:${d}`), user_id: U.s1, device_id: uid('device:s1'), date: d, started_at: ist(d, '09:29'), last_seen_at: ist(d, '18:31'), ended_at: ist(d, '18:31'), duration_sec: 32520, created_at: ist(d, '09:29'), updated_at: ist(d, '18:31') }))));
  sql.push(insert('screenshots', [d0, d1].map((d) => ({ id: uid(`shot:${d}`), device_id: uid('device:s1'), user_id: U.s1, storage_key: `uploads/mig40/${d}.jpg`, kind: raw(`'AUTO'::"ScreenshotKind"`), taken_at: ist(d, '12:00'), ocr_text: null, archived_at: null, created_at: ist(d, '12:00') }))));
  sql.push(insert('chat_messages', [
    { id: uid('chat:1'), from_user_id: U.m1, to_user_id: U.s1, body: 'Can you share the board photos?', read_at: ist(d0, '10:05'), created_at: ist(d0, '10:00') },
    { id: uid('chat:2'), from_user_id: U.s1, to_user_id: U.m1, body: 'Uploaded to the shared drive.', read_at: null, created_at: ist(d0, '10:07') },
  ]));
  sql.push(insert('notifications', [
    { id: uid('notif:1'), user_id: U.s1, type: 'CHAT', title: 'New message', body: 'Can you share the board photos?', read_at: null, created_at: ist(d0, '10:00'), from_user_id: U.m1 },
    { id: uid('notif:2'), user_id: U.m1, type: 'SKIP_REQUESTED', title: 'Skip requested', body: null, read_at: null, created_at: ist(RECENT, '16:00'), from_user_id: null },
  ]));
  sql.push(insert('audit_logs', [
    { id: uid('audit:1'), actor_id: U.sa1, action: 'MONTH_LOCKED', entity: 'MONTH', entity_id: LLM, metadata: jsonb({ month: LLM }), created_at: ist(`${LM}-02`, '10:00') },
    { id: uid('audit:2'), actor_id: U.sa1, action: 'SETTINGS_UPDATED', entity: 'SETTINGS', entity_id: 'org', metadata: jsonb({ changed: ['approvalSlaHours'] }), created_at: daysAgo(3) },
  ]));
  sql.push(insert('refresh_tokens', [{ id: uid('rt:1'), user_id: U.s1, token_hash: md5('refresh-s1'), expires_at: daysAgo(2), revoked_at: null, replaced_by_id: null, user_agent: 'RXVisionAgent/3.1.0 (Windows)', ip: '10.0.0.7', created_at: daysAgo(9) }]));
  sql.push(insert('permission_requests', [{ id: uid('perm:1'), user_id: U.s1, kind: 'SCREENSHOTS_OFF', reason: 'Customer documents on screen', status: raw(`'PENDING'::"PermissionRequestStatus"`), decided_by: null, decided_at: null, created_at: daysAgo(4) }]));

  return {
    sql: sql.join('\n'), C, U, S, A, B, M, R, people, org31, s1Expected, lockedFocus,
    live: two ? [C.c1, C.c2] : [C.c1],
  };
}

// ---- VOLUME: six months of a 3.1 office ---------------------------------------------------
function volumeSql(sc, F) {
  const staff = 40 * VOLUME;
  const managers = 4 * VOLUME;
  // About six months of Monday-to-Saturday days, ending a week before today.
  const days = [];
  for (let d = addDays(TODAY, -8); days.length < 156; d = addDays(d, -1)) if (weekday(d) !== 0) days.push(d);
  const comp = sc === 'B' ? `(CASE WHEN i % 2 = 0 THEN '${F.C.c1}' ELSE '${F.C.c2}' END)::uuid` : `(CASE WHEN i % 50 = 0 THEN NULL ELSE '${F.C.c1}' END)::uuid`;
  const depts = `(ARRAY['Production','production ','Quality Control','Field Support','Design','Firmware'])[1 + i % 6]`;
  const samples = VOLUME * 100_000;
  return `
INSERT INTO users (id, email, password_hash, first_name, last_name, department, status, role_id, company_id, created_at, updated_at, screenshots_enabled)
SELECT md5('mig40-vol-m' || i)::uuid, 'vol.m' || i || '@mig40.test', 'x', 'Manager', 'V' || i, ${depts}, 'ACTIVE', (SELECT id FROM roles WHERE name = 'MANAGER'),
       ${comp}, now() - interval '200 days', now() - interval '200 days', true
FROM generate_series(1, ${managers}) i;
INSERT INTO users (id, email, password_hash, first_name, last_name, department, status, role_id, manager_id, company_id, created_at, updated_at, screenshots_enabled)
SELECT md5('mig40-vol-u' || i)::uuid, 'vol.u' || i || '@mig40.test', 'x', 'Staff', 'V' || i, ${depts}, 'ACTIVE', (SELECT id FROM roles WHERE name = 'USER'),
       md5('mig40-vol-m' || (1 + i % ${managers}))::uuid, ${comp}, now() - interval '200 days', now() - interval '200 days', true
FROM generate_series(1, ${staff}) i;
-- In B, keep each Staff member's manager in their company (the odd/even split above).
UPDATE users u SET manager_id = m.id FROM users m
WHERE u.email LIKE 'vol.u%' AND m.email LIKE 'vol.m%' AND u.company_id IS DISTINCT FROM m.company_id
  AND m.id = (SELECT x.id FROM users x WHERE x.email LIKE 'vol.m%' AND x.company_id IS NOT DISTINCT FROM u.company_id ORDER BY x.email LIMIT 1);

CREATE TEMP TABLE vol_days AS
SELECT u.id AS user_id, d AS date, ((d || ' 04:00')::timestamp + (random() * 40)::int * interval '1 minute')::timestamp(3) AS login_at, random() AS r
FROM users u CROSS JOIN unnest(ARRAY[${days.map((d) => `'${d}'`).join(',')}]::text[]) d
WHERE u.email LIKE 'vol.%' AND random() < 0.93;

INSERT INTO work_day_ends (id, user_id, date, ended_at, created_at, login_at)
SELECT md5('wde' || user_id || date)::uuid, user_id, date, login_at + interval '9 hours', login_at, login_at FROM vol_days;
INSERT INTO work_sessions (id, user_id, date, started_at, ended_at, end_reason, source, created_at, updated_at)
SELECT md5('ws' || user_id || date)::uuid, user_id, date, login_at, login_at + interval '9 hours',
       CASE WHEN r < 0.9 THEN 'USER' ELSE 'AUTO_CLOSED' END::"WorkSessionEndReason", CASE WHEN date < '${CM}-14' THEN 'BACKFILL' ELSE 'AGENT' END,
       login_at, login_at + interval '9 hours' FROM vol_days;

CREATE TEMP TABLE vol_breaks AS
SELECT v.user_id, v.date, k.kind, k.dur, (v.date || ' ' || k.at)::timestamp(3) AS sched,
       ((v.date || ' ' || k.at)::timestamp + (random() * 6)::int * interval '1 minute')::timestamp(3) AS started,
       random() AS r, random() AS q
FROM vol_days v CROSS JOIN (VALUES ('MORNING', '05:30', 15), ('LUNCH', '07:30', 30), ('EVENING', '10:30', 15)) k(kind, at, dur);
INSERT INTO presence_sessions (id, user_id, type, date, started_at, ended_at, duration_sec, created_at, updated_at)
SELECT md5('ps' || user_id || date || kind)::uuid, user_id, CASE WHEN kind = 'LUNCH' THEN 'LUNCH' ELSE 'BREAK' END::"PresenceType", date,
       started, started + (dur + CASE WHEN q < 0.1 THEN (q * 100)::int ELSE 0 END) * interval '1 minute',
       (dur + CASE WHEN q < 0.1 THEN (q * 100)::int ELSE 0 END) * 60, started, started
FROM vol_breaks WHERE r >= 0.05;
INSERT INTO break_records (id, user_id, date, kind, seq, presence_type, shift_name, scheduled_start, duration_min, presence_session_id, started_at,
  timing, minutes_off, reason, source, approval_status, approver_role, approver_id, decided_at, created_at, updated_at, due_at, outcome)
SELECT md5('br' || b.user_id || b.date || b.kind)::uuid, b.user_id, b.date, b.kind::"BreakKind", 0,
       CASE WHEN b.kind = 'LUNCH' THEN 'LUNCH' ELSE 'BREAK' END::"PresenceType", 'General', b.sched, b.dur,
       CASE WHEN b.r >= 0.05 THEN md5('ps' || b.user_id || b.date || b.kind)::uuid END, b.started, 'ON_TIME', 0,
       CASE WHEN b.r < 0.05 THEN 'Customer visit through the break' END, 'AGENT',
       (CASE WHEN b.r < 0.05 THEN 'APPROVED' WHEN b.q > 0.995 THEN 'PENDING' ELSE 'NOT_REQUIRED' END)::"BreakApprovalStatus",
       (CASE WHEN b.r < 0.05 OR b.q > 0.995 THEN CASE WHEN b.q > 0.998 THEN 'SUPER_ADMIN' ELSE 'MANAGER' END END)::"RoleName",
       CASE WHEN (b.r < 0.05 OR b.q > 0.995) AND b.q <= 0.998 THEN u.manager_id END,
       CASE WHEN b.r < 0.05 THEN b.started + interval '3 hours' END, b.started, b.started,
       CASE WHEN b.q > 0.995 AND b.r >= 0.05 THEN b.started + interval '48 hours' END,
       (CASE WHEN b.r < 0.05 THEN 'SKIPPED' ELSE 'TAKEN' END)::"BreakOutcome"
FROM vol_breaks b JOIN users u ON u.id = b.user_id;
INSERT INTO meeting_records (id, user_id, date, mode, agenda, participants, started_at, ended_at, duration_sec, approval_status, approver_role, approver_id,
  decided_at, created_at, updated_at)
SELECT md5('mr' || v.user_id || v.date)::uuid, v.user_id, v.date, 'PAST', 'Weekly review', '[{"name":"Team"}]', v.login_at + interval '6 hours',
       v.login_at + interval '6 hours 30 minutes', 1800, 'APPROVED', 'MANAGER', u.manager_id, v.login_at + interval '8 hours',
       v.login_at + interval '7 hours', v.login_at + interval '8 hours'
FROM vol_days v JOIN users u ON u.id = v.user_id WHERE v.r < 0.2;
INSERT INTO activity_samples (id, user_id, date, at, duration_sec, idle, app, title)
SELECT md5('as' || v.user_id || v.date || g)::uuid, v.user_id, v.date, v.login_at + g * interval '1 minute' * (540 / k.n), 60, g % 9 = 8,
       (ARRAY['EXCEL.EXE','chrome.exe','KiCad','OUTLOOK.EXE'])[1 + g % 4], 'Work item ' || (g % 40)
FROM vol_days v CROSS JOIN (SELECT ceil(${samples}::numeric / greatest(1, (SELECT count(*) FROM vol_days)))::int AS n) k
CROSS JOIN LATERAL generate_series(0, k.n - 1) g
LIMIT ${samples};
DROP TABLE vol_breaks;
DROP TABLE vol_days;
`;
}

// =====================================================================================
// The runbook's queries (DEPLOY.md), read from the runbook itself
// =====================================================================================
function runbookQueries() {
  const text = readFileSync(DEPLOY_MD, 'utf8');
  const all = [...text.matchAll(/^rxsql "(.*)"\s*$/gm)].map((m) => m[1]);
  const find = (...marks) => all.find((q) => marks.every((m) => q.includes(m))) ?? null;
  return {
    migrations: all.find((q) => /FROM _prisma_migrations ORDER BY started_at$/.test(q)) ?? null,
    version: find("current_setting('server_version')"),
    companies: find('FROM companies WHERE deleted_at IS NULL ORDER BY created_at'),
    roles44: find('without_company'),
    depts44: find('AS spellings'),
    managers44: find('will_look_after'),
    staff44: find('manager_in_3_1'),
    pending: find("'break' AS item"),
    settings: find('SELECT key, updated_at FROM app_settings ORDER BY key'),
    locks: find('SELECT month, locked_at FROM month_locks'),
    counts45: find('taken_breaks'),
    defaults45: find('AS default_shift'),
    edges44: find("'\\A\\s|\\s\\Z'", 'AS department'),
    fix152: find('UPDATE users SET department'),
    demo: find('admin@timechamp.test'),
    applied: find("migration_name LIKE '20261020%'"),
    roles66: find('SELECT name::text AS role FROM roles'),
    people66: find('AS without_org', 'department_id IS NULL'),
    orgs66: find('AS departments FROM companies'),
    depts66: find('d.icon', 'AS managers'),
    managers66: find('looks_after'),
    counts66: find('locks_without_org'),
    segments66: find('breaks_with_segments'),
  };
}

// =====================================================================================
// Shift resolution: the 3.1 and 4.0 rules are the same code (shifts/domain/shift-resolution.ts)
// =====================================================================================
function resolveShift(person, dateKey, assignments, shiftsById, defaults) {
  const inForce = (a) => a.effectiveFrom <= dateKey && (!a.effectiveTo || a.effectiveTo >= dateKey);
  const newest = (a, b) => (a.effectiveFrom !== b.effectiveFrom ? (a.effectiveFrom < b.effectiveFrom ? 1 : -1) : b.createdAt.getTime() - a.createdAt.getTime());
  const top = assignments.filter((a) => a.target === 'USER' && a.userId === person.id && inForce(a)).sort(newest)[0];
  if (top?.shiftId && shiftsById.has(top.shiftId)) return { shift: shiftsById.get(top.shiftId), source: 'OVERRIDE' };
  const key = deptKey(person.department);
  if (key) {
    const dept = assignments
      .filter((a) => a.target === 'DEPARTMENT' && a.departmentKey === key && (a.companyId === null || a.companyId === person.companyId) && inForce(a))
      .sort((a, b) => {
        const sa = a.companyId === null ? 1 : 0;
        const sb = b.companyId === null ? 1 : 0;
        return sa !== sb ? sa - sb : newest(a, b);
      })[0];
    if (dept?.shiftId && shiftsById.has(dept.shiftId)) return { shift: shiftsById.get(dept.shiftId), source: 'DEPARTMENT' };
  }
  const def = defaults.find((s) => s.isDefault && s.companyId !== null && s.companyId === person.companyId) ?? defaults.find((s) => s.isDefault && s.companyId === null);
  return def ? { shift: def, source: 'DEFAULT' } : { shift: null, source: 'NONE' };
}

// =====================================================================================
// One scenario
// =====================================================================================
const timings = [];

async function scenario(sc) {
  const two = sc === 'B';
  const name = `rxv_mig40_${process.pid}_${sc.toLowerCase()}`;
  if (RESERVED.has(name) || name === BASE_DB) throw new Error(`refusing database name ${name}`);
  console.log(`\n================ Scenario ${sc}: ${two ? 'two companies' : 'one company'}${VOLUME ? `, VOLUME=${VOLUME}` : ''} ================`);
  const work = mkdtempSync(join(tmpdir(), 'rxv-mig40-'));
  live.dirs.add(work);
  const schemaFile = 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n';
  for (const dir of ['step', 'all']) {
    mkdirSync(join(work, dir, 'migrations'), { recursive: true });
    writeFileSync(join(work, dir, 'schema.prisma'), schemaFile);
    cpSync(join(MIGRATIONS, 'migration_lock.toml'), join(work, dir, 'migrations', 'migration_lock.toml'));
  }
  const allNames = readdirSync(MIGRATIONS).filter((n) => /^\d/.test(n)).sort();
  for (const n of allNames) cpSync(join(MIGRATIONS, n), join(work, 'all', 'migrations', n), { recursive: true });
  const prismaEnv = { ...process.env, DATABASE_URL: urlOf(name), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  const prisma = (dir, args) => {
    try {
      return { code: 0, out: execFileSync(PRISMA_BIN, [...args, '--schema', join(work, dir, 'schema.prisma')], { cwd: join(work, dir), env: prismaEnv, stdio: 'pipe', encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  /** `prisma migrate deploy` with these migrations added to the step folder; ms taken. */
  const deploy = (names) => {
    for (const n of names) cpSync(join(MIGRATIONS, n), join(work, 'step', 'migrations', n), { recursive: true });
    const t0 = Date.now();
    const r = prisma('step', ['migrate', 'deploy']);
    if (r.code !== 0) throw new Error(`migrate deploy failed: ${scrub(r.out)}`);
    return Date.now() - t0;
  };

  let db = null;
  try {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${name}"`]);
    psql('postgres', ['-c', `CREATE DATABASE "${name}"`]);
    live.dbs.add(name);
    deploy(allNames.filter((n) => n <= LAST_31));
    db = new PrismaClient({ datasources: { db: { url: urlOf(name) } } });
    const q = async (sqlText, ...params) =>
      JSON.parse(JSON.stringify(await db.$queryRawUnsafe(sqlText, ...params), (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
    const one = async (sqlText, ...params) => (await q(sqlText, ...params))[0];
    const RB = runbookQueries();
    const rb = async (key) => {
      if (!RB[key]) {
        check(`runbook query "${key}" found in DEPLOY.md`, false);
        return [];
      }
      return q(RB[key]);
    };

    console.log('\n# 3.1 data');
    const F = buildFixture(sc);
    psqlText(name, F.sql, work);
    check('3.1 rows written (every backfill case)', true);
    if (VOLUME > 0) {
      const t0 = Date.now();
      psqlText(name, volumeSql(sc, F), work);
      psql(name, ['-c', 'VACUUM ANALYZE']);
      console.log(`  volume data written in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    const sizes = await one(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM work_sessions)::int AS sessions,
      (SELECT count(*) FROM break_records)::int AS breaks, (SELECT count(*) FROM presence_sessions)::int AS presence,
      (SELECT count(*) FROM meeting_records)::int AS meetings, (SELECT count(*) FROM activity_samples)::int AS samples,
      pg_size_pretty(pg_database_size(current_database())) AS size`);
    console.log(`  ${sizes.users} people, ${sizes.sessions} work sessions, ${sizes.breaks} break records, ${sizes.presence} presence sessions, ${sizes.meetings} meetings, ${sizes.samples} activity samples (${sizes.size})`);

    // ---- Before -------------------------------------------------------------------------------
    console.log('\n# Before the migration (DEPLOY.md 4.3 to 4.5)');
    const mig = await rb('migrations');
    check('4.3: seven migrations, 0_init first and the 3.1 backfill last, all finished',
      mig.length === 7 && mig[0]?.migration_name === '0_init' && mig[6]?.migration_name === LAST_31 && mig.every((m) => m.finished_at && !m.rolled_back_at), mig.map((m) => m.migration_name));
    const [ver] = await rb('version');
    check('4.3: PostgreSQL 12 or later', Number(String(ver?.postgres).split('.')[0]) >= 12, ver);
    const companies44 = await rb('companies');
    check(`4.4: ${two ? 'two companies' : 'one company'} (the deleted one not listed)`, companies44.length === (two ? 2 : 1), companies44.map((c) => c.name));
    const roles44 = await rb('roles44');
    check('4.4: roles MANAGER, SUPER_ADMIN and USER only', roles44.map((r) => r.role).join() === 'MANAGER,SUPER_ADMIN,USER', roles44);
    const depts44 = await rb('depts44');
    const managers44 = await rb('managers44');
    const staff44 = await rb('staff44');
    const pending45 = await rb('pending');
    const settings45 = await rb('settings');
    const locks45 = await rb('locks');
    const [counts45] = await rb('counts45');
    const defaults45 = await rb('defaults45');
    check(`4.5: default shifts ${two ? '(two companies: listed for the record)' : 'one row, the company-less default'}`, two || (defaults45.length === 1 && defaults45[0].company === '(no company)'), defaults45);
    const edges44 = await rb('edges44');
    check('4.4: the query for department texts that break the backfill finds the legacy "Sales<TAB>"', edges44.length === 1 && edges44[0].department === 'Sales<TAB>', edges44);
    const demo = await rb('demo');
    check('4.7: no demo account', demo.length === 0, demo);
    console.log(`  roles: ${roles44.map((r) => `${r.role} ${r.people} (no company ${r.without_company}, no department ${r.without_department})`).join('; ')}`);
    console.log(`  departments forecast: ${depts44.map((d) => JSON.stringify(d.department)).join(', ')}`);
    console.log(`  pending: ${pending45.map((p) => `${p.item}/${p.routed_to} ${p.pending}`).join(', ')}; settings ${settings45.map((s) => s.key).join(', ')}; locks ${locks45.length}; ${JSON.stringify(counts45)}`);

    // Copies of every table the backfill may change, for the comparisons after it.
    const COPIED = ['roles', 'companies', 'users', 'shifts', 'shift_breaks', 'shift_assignments', 'app_settings', 'month_locks', 'report_runs', 'break_records', 'meeting_records'];
    psql(name, ['-c', `CREATE SCHEMA rxv_before; ${COPIED.map((t) => `CREATE TABLE rxv_before.${t} AS SELECT * FROM ${SCHEMA}.${t};`).join(' ')}`]);
    const UNTOUCHED = ['work_sessions', 'work_day_ends', 'presence_sessions', 'activity_samples', 'online_sessions', 'daily_reports', 'devices', 'screenshots', 'chat_messages', 'notifications', 'audit_logs', 'refresh_tokens', 'permission_requests'];
    const tableHash = async (tables, schema = SCHEMA) => {
      const out = {};
      for (const t of tables) {
        const r = await one(`SELECT count(*)::int AS n, coalesce(sum(('x' || substr(md5(t::text), 1, 15))::bit(60)::bigint), 0)::text AS h FROM ${schema}.${t} t`);
        out[t] = `${r.n}:${r.h}`;
      }
      return out;
    };
    const untouchedBefore = await tableHash(UNTOUCHED);

    // Every person's shift today, by the 3.1 rules on 3.1 data.
    const shiftsToday = async (schema) => {
      const shifts = await q(`SELECT id::text, company_id::text AS "companyId", name, start, "end", is_default AS "isDefault" FROM ${schema}.shifts WHERE deleted_at IS NULL ORDER BY is_default DESC, start ASC, name ASC`);
      const assignments = (await q(`SELECT id::text, target::text, company_id::text AS "companyId", department_key AS "departmentKey", user_id::text AS "userId",
          shift_id::text AS "shiftId", effective_from AS "effectiveFrom", effective_to AS "effectiveTo", created_at AS "createdAt" FROM ${schema}.shift_assignments`))
        .map((a) => ({ ...a, createdAt: new Date(a.createdAt) }));
      const people = await q(`SELECT id::text, company_id::text AS "companyId", department FROM ${schema}.users WHERE deleted_at IS NULL`);
      const byId = new Map(shifts.map((s) => [s.id, s]));
      const defaults = shifts.filter((s) => s.isDefault);
      const out = new Map();
      for (const p of people) {
        const fwd = resolveShift(p, TODAY, assignments, byId, defaults);
        const rev = resolveShift(p, TODAY, assignments, byId, [...defaults].reverse());
        const sig = (r) => (r.shift ? `${r.shift.name} ${r.shift.start}-${r.shift.end}` : 'none');
        out.set(p.id, { companyId: p.companyId, shift: sig(fwd), ambiguous: sig(fwd) !== sig(rev), source: fwd.source });
      }
      return out;
    };
    const shiftsBefore = await shiftsToday(SCHEMA);

    // ---- Migrate ---------------------------------------------------------------------------------
    console.log('\n# The 4.0 migrations, one at a time (prisma migrate deploy)');
    const status = prisma('all', ['migrate', 'status']);
    check('6.4: migrate status lists 10 migrations, exactly the three 4.0 ones pending (exit code 1)',
      status.code === 1 && /10 migrations found/.test(status.out) && /not yet been applied:\s*\n\s*20261020_v40_1_enums\s*\n\s*20261020_v40_2_orgs\s*\n\s*20261020_v40_3_backfill\s*\n/.test(status.out), scrub(status.out).slice(-400));
    const wall = [];
    let retried = false;
    for (const m of V40) {
      try {
        wall.push(deploy([m]));
        check(`${m} applies`, true);
      } catch (e) {
        check(`${m} applies`, false, scrub(e.message).split('\n').filter((l) => /^(ERROR|DETAIL)/.test(l)));
        if (m !== V40[2]) throw e;
        // What breaks it: department text with a tab, line break or other non-space whitespace at
        // an end, next to the same name without it (DEPLOY.md 4.4 lists these rows).
        const edge = await rb('edges44');
        console.log(`  rows with whitespace other than spaces at an end of the department text: ${edge.map((x) => `${x.email} ${JSON.stringify(x.department)}`).join(', ')}`);
        // DEPLOY.md 15.2: mark it rolled back, fix the cause with the runbook's own query (what 3.1
        // stores when the person's department is saved again: trimmed, blank = none), deploy again.
        const resolve = prisma('step', ['migrate', 'resolve', '--rolled-back', m]);
        check('15.2: migrate resolve --rolled-back', resolve.code === 0 && /marked as rolled back/.test(resolve.out), scrub(resolve.out).slice(-300));
        const fixed = RB.fix152 ? await q(RB.fix152) : [];
        check("15.2: the runbook's fix query re-saves exactly 4.4's rows", fixed.map((x) => x.email).sort().join() === edge.map((x) => x.email).sort().join() && edge.length > 0, { fixed, edge });
        if (RB.fix152) await q(RB.fix152.replace('UPDATE users', 'UPDATE rxv_before.users')); // the "before" copy follows the 3.1 data
        wall.push(deploy([]));
        retried = true;
        check(`after 15.2 and re-saving those ${edge.length} department(s), ${m} applies`, true);
      }
    }
    if (retried) {
      // The forecasts of 4.4 as the operator would take them after the fix.
      depts44.splice(0, depts44.length, ...(await rb('depts44')));
      managers44.splice(0, managers44.length, ...(await rb('managers44')));
      staff44.splice(0, staff44.length, ...(await rb('staff44')));
    }
    const applied = await q(`SELECT migration_name AS name, (extract(epoch FROM finished_at - started_at) * 1000)::int AS ms, finished_at IS NOT NULL AND rolled_back_at IS NULL AS ok
      FROM _prisma_migrations WHERE migration_name LIKE '20261020%' AND rolled_back_at IS NULL ORDER BY started_at`);
    check('the three applied, in order, finished', applied.length === 3 && applied.every((a, i) => a.name === V40[i] && a.ok), applied);
    V40.forEach((m, i) => console.log(`  ${m}: ${applied[i]?.ms} ms in the database, ${wall[i]} ms with Prisma`));
    timings.push({ scenario: sc, volume: VOLUME, samples: sizes.samples, breaks: sizes.breaks, db: applied.map((a) => a.ms), wall });
    const after = prisma('all', ['migrate', 'status']);
    check('migrate status afterwards: up to date', after.code === 0 && /Database schema is up to date/.test(after.out), scrub(after.out).slice(-300));

    // ---- Runbook checks after (6.6) ----------------------------------------------------------------
    console.log('\n# After the migration: the runbook (DEPLOY.md 6.6)');
    const applied66 = await rb('applied');
    const done66 = applied66.filter((r) => !r.rolled_back_at);
    check(`6.6 #1: the three 4.0 migrations finished${retried ? ', plus the rolled-back attempt' : ''}`,
      done66.length === 3 && done66.every((r, i) => r.migration_name === V40[i] && r.finished_at) && applied66.length === 3 + (retried ? 1 : 0), applied66);
    const roles66 = await rb('roles66');
    check('6.6 #2: roles ADMIN, MANAGER, SUPER_ADMIN, USER', roles66.map((r) => r.role).join() === 'ADMIN,MANAGER,SUPER_ADMIN,USER', roles66);
    const people66 = await rb('people66');
    const roleRow = (rows, role) => rows.find((r) => r.role === role) ?? {};
    check('6.6 #3: the same people per role as 4.4, nobody ADMIN', ['MANAGER', 'SUPER_ADMIN', 'USER'].every((r) => roleRow(people66, r).people === roleRow(roles44, r).people) && !people66.some((r) => r.role === 'ADMIN'), { before: roles44, after: people66 });
    const orgs66 = await rb('orgs66');
    const depts66 = await rb('depts66');
    const managers66 = await rb('managers66');
    const settings66 = await rb('settings');
    const [counts66] = await rb('counts66');
    const pending66 = await rb('pending');
    const [segments66] = await rb('segments66');
    if (!two) {
      check('6.6 #3: no organisation 0 for MANAGER and USER', roleRow(people66, 'MANAGER').without_org === 0 && roleRow(people66, 'USER').without_org === 0, people66);
      check('6.6 #3: USER without department = the Staff list of 4.4', roleRow(people66, 'USER').without_department === staff44.length, { after: roleRow(people66, 'USER'), staff44: staff44.map((s) => s.email) });
      const mgrsNoText = await one(`SELECT count(*)::int AS n FROM rxv_before.users u JOIN rxv_before.roles r ON r.id = u.role_id AND r.name::text = 'MANAGER' WHERE u.deleted_at IS NULL AND nullif(btrim(u.department), '') IS NULL`);
      check('6.6 #3: MANAGER without department = Managers with no department text', roleRow(people66, 'MANAGER').without_department === mgrsNoText.n, { after: roleRow(people66, 'MANAGER'), expected: mgrsNoText.n });
      check('6.6 #4: one organisation, with as many departments as 4.4 listed', orgs66.length === 1 && orgs66[0].departments === depts44.length, { orgs66, forecast: depts44.length });
      check('6.6 #5: one row per department of 4.4', depts66.map((d) => d.name).sort().join('|') === depts44.map((d) => d.department).sort().join('|'), { after: depts66.map((d) => d.name), forecast: depts44.map((d) => d.department) });
      const fc = new Map(managers44.map((m) => [m.manager, m.will_look_after]));
      const mismatch = managers66.filter((m) => fc.get(m.manager) !== m.looks_after);
      check("6.6 #6: each Manager's departments = 4.4's will_look_after", mismatch.length === 0, mismatch.map((m) => ({ manager: m.manager, forecast: fc.get(m.manager), after: m.looks_after })));
      check('6.6 #8: month locks and report runs as 4.5, nothing without an organisation', counts66.month_locks === locks45.length && counts66.report_runs === counts45.report_runs &&
        counts66.locks_without_org === 0 && counts66.runs_without_org === 0 && counts66.shifts_without_org === 0 && counts66.assignments_without_org === 0, { counts45, counts66 });
    }
    const keys66 = settings66.map((s) => s.key).sort();
    const keysExpected = [...settings45.map((s) => s.key), ...F.live.map((c) => `org:${c}`)].sort();
    check('6.6 #7: system, org and org:<id> per organisation', keys66.join() === keysExpected.join(), { after: keys66, expected: keysExpected });
    const pend = (rows, item, role) => rows.find((r) => r.item === item && r.routed_to === role)?.pending ?? 0;
    check('6.6 #9: nothing pending for SUPER_ADMIN; ADMIN = 4.5 SUPER_ADMIN; MANAGER unchanged',
      ['break', 'meeting'].every((i) => pend(pending66, i, 'SUPER_ADMIN') === 0 && pend(pending66, i, 'ADMIN') === pend(pending45, i, 'SUPER_ADMIN') && pend(pending66, i, 'MANAGER') === pend(pending45, i, 'MANAGER')),
      { before: pending45, after: pending66 });
    const openBefore = counts45.open_breaks ?? null;
    check('6.6 #10: breaks with segments = 4.5 taken_breaks; active = 4.5 open_breaks; paused 0',
      segments66.breaks_with_segments === counts45.taken_breaks && segments66.paused === 0 && openBefore !== null && segments66.active === openBefore,
      { counts45, segments66 });
    console.log(`  per role: ${people66.map((r) => `${r.role} ${r.people} (no org ${r.without_org}, no department ${r.without_department})`).join('; ')}`);
    console.log(`  departments: ${depts66.map((d) => `${JSON.stringify(d.name)} ${d.icon} staff ${d.staff} managers ${d.managers}`).join('; ')}`);
    console.log(`  managers: ${managers66.map((m) => `${m.manager.split('@')[0]}: ${m.looks_after}`).join('; ')}`);

    // ---- Invariants ----------------------------------------------------------------------------------
    console.log('\n# Organisations and people');
    const users = new Map((await q(`SELECT u.id::text, u.email, u.company_id::text AS company, u.department, u.department_id::text AS dept, u.deleted_at IS NOT NULL AS deleted, r.name::text AS role
      FROM users u JOIN roles r ON r.id = u.role_id`)).map((u) => [u.id, u]));
    const usersBefore = new Map((await q(`SELECT u.id::text, u.company_id::text AS company, r.name::text AS role FROM rxv_before.users u JOIN rxv_before.roles r ON r.id = u.role_id`)).map((u) => [u.id, u]));
    const companiesAfter = await q(`SELECT id::text, name, deleted_at IS NOT NULL AS deleted FROM companies ORDER BY created_at`);
    check('no company created, none changed', (await one(`SELECT count(*)::int AS n FROM (SELECT * FROM companies EXCEPT SELECT * FROM rxv_before.companies) x`)).n === 0 && companiesAfter.length === (two ? 3 : 2), companiesAfter);
    if (!two) {
      const wrong = [...users.values()].filter((u) => u.role !== 'SUPER_ADMIN' && u.company === null);
      check('A: every non-Super-Admin has a company (soft-deleted ones too)', wrong.length === 0, wrong.map((u) => u.email));
      const moved = [...users.values()].filter((u) => usersBefore.get(u.id).company === null && u.role !== 'SUPER_ADMIN');
      const fixtureMoved = moved.filter((u) => !u.email.startsWith('vol.')).map((u) => u.email.split('@')[0]).sort();
      check(`A: people with no company joined the company (${fixtureMoved.join(', ')}${VOLUME ? ' and the volume ones' : ''})`, moved.every((u) => u.company === F.C.c1) && fixtureMoved.join() === 'm6,s16,s9', moved.map((u) => `${u.email} ${u.company}`));
      check('A: everyone active and not a Super Admin is in the live company', [...users.values()].filter((u) => !u.deleted && u.role !== 'SUPER_ADMIN').every((u) => u.company === F.C.c1));
    } else {
      const changed = [...users.values()].filter((u) => usersBefore.get(u.id).company !== u.company);
      check('B: nobody changed company; people with no company stay without one', changed.length === 0, changed.map((u) => u.email));
    }
    const sa = [F.U.sa1, F.U.sa2].map((id) => users.get(id));
    check('Super Admins keep their company (or none)', sa[0].company === F.C.c1 && sa[1].company === null, sa);
    const roleAfter = await q(`SELECT name::text AS name, count(*)::int AS n FROM roles GROUP BY 1 ORDER BY 1`);
    check('one ADMIN role row, nobody has it', roleAfter.map((r) => `${r.name}:${r.n}`).join() === 'ADMIN:1,MANAGER:1,SUPER_ADMIN:1,USER:1' &&
      (await one(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ADMIN'`)).n === 0, roleAfter);
    check('the 3.1 role rows unchanged', (await one(`SELECT count(*)::int AS n FROM (SELECT * FROM rxv_before.roles EXCEPT SELECT * FROM roles) x`)).n === 0);

    console.log('\n# Departments');
    const depts = await q(`SELECT id::text, company_id::text AS company, name, icon, deleted_at IS NOT NULL AS deleted FROM departments ORDER BY company_id, name`);
    // Expected: one per (live company, app key) among non-deleted people with a non-blank department.
    const want = new Map();
    for (const u of users.values()) {
      const k = deptKey(u.department);
      if (u.deleted || !u.company || !k) continue;
      if (!F.live.includes(u.company)) continue;
      const g = want.get(`${u.company}|${k}`) ?? { company: u.company, key: k, spellings: [] };
      g.spellings.push(tidy(u.department));
      want.set(`${u.company}|${k}`, g);
    }
    for (const g of want.values()) g.name = (await one(`SELECT min(x) AS name FROM unnest($1::text[]) x`, g.spellings)).name;
    const keyOf = (d) => `${d.company}|${deptKey(d.name)}`;
    const dupes = Object.entries(depts.reduce((m, d) => ({ ...m, [keyOf(d)]: [...(m[keyOf(d)] ?? []), d.name] }), {})).filter(([, v]) => v.length > 1);
    check('one department per company per name, ignoring case and spacing (the app\'s rule)', dupes.length === 0, dupes.map(([k, v]) => ({ key: k, names: v })));
    const missing = [...want.values()].filter((g) => !depts.some((d) => keyOf(d) === `${g.company}|${g.key}`));
    check('every department name in use has its department', missing.length === 0, missing);
    const extra = depts.filter((d) => !want.has(keyOf(d)));
    check('no department from soft-deleted people, blanks or the deleted company', extra.length === 0, extra);
    const misnamed = depts.filter((d) => want.has(keyOf(d)) && want.get(keyOf(d)).name !== d.name);
    check('each named after the first spelling in sort order, spaces tidied', misnamed.length === 0, misnamed.map((d) => ({ name: d.name, expected: want.get(keyOf(d)).name })));
    const badIcon = depts.filter((d) => d.icon !== iconFor(deptKey(d.name) ?? ''));
    check('icons follow the table in DEPLOY.md 6.5', badIcon.length === 0, badIcon.map((d) => ({ name: d.name, icon: d.icon, table: iconFor(deptKey(d.name) ?? '') })));
    if (!two) {
      const names = depts.map((d) => d.name).sort();
      console.log(`  ${names.map((n) => JSON.stringify(n)).join(', ')}`);
    } else {
      for (const c of F.live) console.log(`  ${c === F.C.c1 ? 'C1' : 'C2'}: ${depts.filter((d) => d.company === c).map((d) => JSON.stringify(d.name)).join(', ')}`);
      const sales = depts.filter((d) => deptKey(d.name) === 'sales');
      check('B: the same name in two companies makes two departments', new Set(sales.map((d) => d.company)).size === 2, sales);
    }
    const deptById = new Map(depts.map((d) => [d.id, d]));
    // A person's department: the one of their company with their text's key, when it exists
    // (for soft-deleted people only if someone active made it); none for blanks or no company.
    const wrongDept = [...users.values()].filter((u) => {
      const k = deptKey(u.department);
      const exists = !!u.company && !!k && depts.some((d) => d.company === u.company && !d.deleted && deptKey(d.name) === k);
      if (!exists) return u.dept !== null;
      const d = u.dept ? deptById.get(u.dept) : null;
      return !d || d.company !== u.company || deptKey(d.name) !== k;
    });
    check('users.department_id: the department of their text and company; none for blanks or no company', wrongDept.length === 0,
      wrongDept.map((u) => ({ email: u.email, text: u.department, dept: u.dept ? deptById.get(u.dept)?.name : null })));
    const textChanged = await one(`SELECT count(*)::int AS n FROM users u JOIN rxv_before.users b USING (id) WHERE u.department IS DISTINCT FROM b.department`);
    check('users.department text kept as it was (4.0 shift rules still read it)', textChanged.n === 0, textChanged);
    const inconsistent = [...users.values()].filter((u) => u.dept && deptKey(deptById.get(u.dept)?.name) !== deptKey(u.department));
    check('users.department text and the department agree by the app\'s key', inconsistent.length === 0, inconsistent.map((u) => ({ email: u.email, text: u.department, dept: deptById.get(u.dept)?.name })));
    const tab = users.get(F.U.s15);
    check('legacy text "Sales<TAB>" ends in the Sales department (the app trims tabs)', deptKey(deptById.get(tab.dept)?.name) === 'sales', { text: tab.department, dept: deptById.get(tab.dept)?.name });
    const softDel = [F.U.s11, F.U.s10, F.U.x0, F.U.m5].map((id) => users.get(id));
    console.log(`  soft-deleted: ${softDel.map((u) => `${u.email.split('@')[0]} -> ${u.dept ? JSON.stringify(deptById.get(u.dept)?.name) : 'none'}`).join(', ')}`);

    console.log("\n# Managers' departments");
    const md = await q(`SELECT md.manager_id::text AS manager, md.department_id::text AS dept FROM manager_departments md`);
    // Expected, by the app's key: every non-deleted Manager with a company looks after the
    // department of their own text and of each non-deleted direct report in their company.
    const expectMd = new Set();
    const reports = await q(`SELECT id::text, manager_id::text AS manager FROM users WHERE manager_id IS NOT NULL AND deleted_at IS NULL`);
    for (const m of users.values()) {
      if (m.role !== 'MANAGER' || m.deleted || !m.company) continue;
      const texts = [m.department, ...reports.filter((r) => r.manager === m.id).map((r) => users.get(r.id)).filter((u) => u.company === m.company).map((u) => u.department)];
      for (const t of texts) if (deptKey(t)) expectMd.add(`${m.id}|${m.company}|${deptKey(t)}`);
    }
    const gotMd = new Set(md.map((x) => `${x.manager}|${deptById.get(x.dept)?.company}|${deptKey(deptById.get(x.dept)?.name)}`));
    const mdMissing = [...expectMd].filter((x) => !gotMd.has(x));
    const mdExtra = [...gotMd].filter((x) => !expectMd.has(x));
    const mdName = (x) => {
      const [m, , k] = x.split('|');
      return `${users.get(m)?.email.split('@')[0]}: ${k}`;
    };
    check("each Manager looks after their direct reports' departments and their own, nothing else", mdMissing.length === 0 && mdExtra.length === 0, { missing: mdMissing.map(mdName), extra: mdExtra.map(mdName) });
    const mdCross = await one(`SELECT count(*)::int AS n FROM manager_departments md JOIN users m ON m.id = md.manager_id JOIN departments d ON d.id = md.department_id WHERE d.company_id IS DISTINCT FROM m.company_id`);
    check("no Manager looks after another company's department", mdCross.n === 0, mdCross);
    const mdOf = (tag) => md.filter((x) => x.manager === F.U[tag]).map((x) => deptById.get(x.dept)?.name).sort();
    check('m1 (R&D; reports in R&D, Electronics, Sales): exactly those', mdOf('m1').map(deptKey).sort().join() === 'electronics,r&d,sales', mdOf('m1'));
    check('m3 (own department, no reports): Quality Assurance', mdOf('m3').join() === 'Quality Assurance', mdOf('m3'));
    check('m4 (no department, no reports): none', mdOf('m4').length === 0, mdOf('m4'));
    check('m5 (soft-deleted): none', mdOf('m5').length === 0, mdOf('m5'));
    check('s17 (3.1 manager is a Super Admin): no manager row for the Super Admin', md.every((x) => x.manager !== F.U.sa1));
    if (two) {
      check("B: m1 gets no department of C2 (s19's manager in 3.1)", md.filter((x) => x.manager === F.U.m1).every((x) => deptById.get(x.dept)?.company === F.C.c1));
      check('B: m6 (no company) looks after nothing', mdOf('m6').length === 0, mdOf('m6'));
    } else {
      check('A: m6 (joined the company) looks after Support', mdOf('m6').map(deptKey).join() === 'support', mdOf('m6'));
    }

    console.log('\n# Shifts and shift assignments');
    const shiftsAfter = await q(`SELECT id::text, company_id::text AS company, name, start, "end", is_default AS "isDefault", deleted_at IS NOT NULL AS deleted FROM shifts`);
    const asgAfter = await q(`SELECT id::text, target::text, company_id::text AS company, department_key AS key, user_id::text AS "user", shift_id::text AS shift, effective_from AS "from", effective_to AS "to" FROM shift_assignments`);
    const asgBefore = new Map((await q(`SELECT id::text, company_id::text AS company, shift_id::text AS shift FROM rxv_before.shift_assignments`)).map((a) => [a.id, a]));
    const shiftDefCols = ['name', 'start', 'end', 'work_days', 'is_default', 'ring_lead_min', 'ring_duration_min', 'ring_sound', 'reason_on_early', 'reason_on_late', 'reason_min_chars', 'overrun_reason', 'overrun_grace_min'];
    const defaultsPer = await q(`SELECT c.id::text AS company, count(s.id)::int AS n, string_agg(s.name, ', ' ORDER BY s.start) AS names FROM companies c
      LEFT JOIN shifts s ON s.company_id = c.id AND s.is_default AND s.deleted_at IS NULL WHERE c.deleted_at IS NULL GROUP BY c.id`);
    if (!two) {
      check('A: every shift has the company (soft-deleted too), no copies', shiftsAfter.length === 4 && shiftsAfter.every((s) => s.company === F.C.c1), shiftsAfter);
      check('A: every assignment has the company, same shift as before', asgAfter.length === asgBefore.size && asgAfter.every((a) => a.company === F.C.c1 && a.shift === asgBefore.get(a.id)?.shift), asgAfter.filter((a) => a.company !== F.C.c1));
      const shiftCols = (await one(`SELECT count(*)::int AS n FROM shifts s JOIN rxv_before.shifts b USING (id) WHERE ROW(${shiftDefCols.map((c) => `s."${c}"`).join(', ')}, s.deleted_at, s.created_at, s.updated_at) IS DISTINCT FROM ROW(${shiftDefCols.map((c) => `b."${c}"`).join(', ')}, b.deleted_at, b.created_at, b.updated_at)`)).n;
      check('A: shifts otherwise unchanged (soft-deleted one stays deleted)', shiftCols === 0, shiftCols);
    } else {
      const liveCompanyless = ['gen', 'night'];
      const copies = shiftsAfter.filter((s) => !Object.values(F.S).includes(s.id));
      const wantCopies = liveCompanyless.flatMap((k) => F.live.map((c) => md5uuid(`rxv-shift-${F.S[k]}${c}`)));
      check('B: each company-less shift copied into each organisation (not the deleted shift or company)', copies.length === wantCopies.length && wantCopies.every((id) => copies.some((s) => s.id === id)), copies.map((s) => `${s.name}@${s.company}`));
      const copyCols = shiftDefCols.filter((x) => x !== 'is_default');
      const same = await one(`SELECT count(*)::int AS n FROM shifts c JOIN rxv_before.shifts o ON c.id = md5('rxv-shift-' || o.id::text || c.company_id::text)::uuid
        WHERE ROW(${copyCols.map((x) => `c."${x}"`).join(', ')}) IS DISTINCT FROM ROW(${copyCols.map((x) => `o."${x}"`).join(', ')})`);
      check('B: copies keep the definition (times, days, rules)', same.n === 0, same);
      // A copy is the default only in a company that had no default of its own.
      const flag = await one(`SELECT count(*)::int AS n FROM shifts c JOIN rxv_before.shifts o ON c.id = md5('rxv-shift-' || o.id::text || c.company_id::text)::uuid
        WHERE c.is_default IS DISTINCT FROM (o.is_default AND NOT EXISTS (
          SELECT 1 FROM rxv_before.shifts d WHERE d.company_id = c.company_id AND d.is_default AND d.deleted_at IS NULL))`);
      check("B: a copied default is the default only where the company had none of its own", flag.n === 0, flag);
      const brkSame = await one(`SELECT
          (SELECT count(*) FROM shift_breaks b JOIN shifts c ON c.id = b.shift_id JOIN rxv_before.shifts o ON c.id = md5('rxv-shift-' || o.id::text || c.company_id::text)::uuid)::int AS copied,
          (SELECT count(*) FROM rxv_before.shift_breaks b JOIN rxv_before.shifts o ON o.id = b.shift_id WHERE o.company_id IS NULL AND o.deleted_at IS NULL)::int * ${F.live.length} AS expected,
          (SELECT count(*) FROM shift_breaks b JOIN shifts c ON c.id = b.shift_id JOIN rxv_before.shifts o ON c.id = md5('rxv-shift-' || o.id::text || c.company_id::text)::uuid
             JOIN rxv_before.shift_breaks ob ON ob.shift_id = o.id AND ob.kind = b.kind
            WHERE ROW(b.enabled, b.start_time, b.duration_min, b.window_before_min, b.window_after_min, b.allow_skip) IS DISTINCT FROM ROW(ob.enabled, ob.start_time, ob.duration_min, ob.window_before_min, ob.window_after_min, ob.allow_skip))::int AS differ`);
      check('B: their breaks copied too', brkSame.copied === brkSame.expected && brkSame.differ === 0, brkSame);
      const originals = shiftsAfter.filter((s) => liveCompanyless.some((k) => F.S[k] === s.id));
      check('B: the company-less originals are soft-deleted and no longer default', originals.length === 2 && originals.every((s) => s.deleted && !s.isDefault), originals);
      check('B: the deleted company-less shift is left alone', shiftsAfter.find((s) => s.id === F.S.old)?.company === null);
      const copyOf = (k, c) => md5uuid(`rxv-shift-${F.S[k]}${c}`);
      const a = (k) => asgAfter.find((x) => x.id === F.A[k]);
      const copiedA = (k, c) => asgAfter.find((x) => x.id === md5uuid(`rxv-assign-${F.A[k]}${c}`));
      check('B: company-less department rows replaced by one per organisation on its copy',
        !a('a1') && !a('a2') && !a('a9a') && F.live.every((c) => copiedA('a1', c)?.shift === copyOf('gen', c) && copiedA('a2', c)?.shift === copyOf('night', c) && copiedA('a9a', c)?.company === c),
        asgAfter.filter((x) => x.target === 'DEPARTMENT').map((x) => `${x.key}@${x.company}->${x.shift}`));
      check("B: a company's department row moves to its copy", a('a6')?.shift === copyOf('gen', F.C.c1) && a('a6')?.company === F.C.c1, a('a6'));
      check("B: personal rows move to the person's organisation's copy", a('a8')?.shift === copyOf('night', F.C.c1) && a('a10')?.shift === copyOf('night', F.C.c2) && a('a10')?.company === F.C.c2, [a('a8'), a('a10')]);
      check('B: a company-less "back to department" row gets the person\'s organisation', a('a5')?.company === F.C.c2 && a('a5')?.shift === null, a('a5'));
      check('B: rows of people with no company are left alone', a('a3')?.company === null && a('a3')?.shift === F.S.gen, a('a3'));
      const noCompanyInForce = asgAfter.filter((x) => x.company === null && (!x.to || x.to >= TODAY) && !(x.user && users.get(x.user)?.company === null));
      check('B: every assignment in force has an organisation (except those of people with none)', noCompanyInForce.length === 0,
        noCompanyInForce.map((x) => ({ id: x.id === F.A.a9 ? 'a9' : x.id, target: x.target, department: x.key, shift: x.shift, from: x.from })));
    }
    check('each organisation has exactly one default shift', defaultsPer.every((d) => d.n === 1), defaultsPer);
    const asgOrphan = await one(`SELECT
        (SELECT count(*) FROM shift_assignments a WHERE a.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = a.company_id))::int AS no_company,
        (SELECT count(*) FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.company_id IS NOT NULL AND a.company_id IS DISTINCT FROM s.company_id)::int AS other_company_shift,
        (SELECT count(*) FROM shift_assignments a JOIN users u ON u.id = a.user_id WHERE a.target = 'USER' AND u.company_id IS NOT NULL AND a.company_id IS DISTINCT FROM u.company_id)::int AS other_company_person`);
    check("assignments: company exists, matches its shift's and its person's", asgOrphan.no_company === 0 && asgOrphan.other_company_shift === 0 && asgOrphan.other_company_person === 0, asgOrphan);
    const shiftsAfterMap = await shiftsToday(SCHEMA);
    const changedShift = [...shiftsAfterMap.entries()].filter(([id, s]) => s.companyId && (shiftsBefore.get(id)?.shift !== s.shift || s.ambiguous));
    check("nobody with an organisation changes shift (3.1 rules, before and after)", changedShift.length === 0,
      changedShift.map(([id, s]) => ({ who: users.get(id)?.email.split('@')[0], before: shiftsBefore.get(id)?.shift, after: s.shift, ambiguous: s.ambiguous })));

    console.log('\n# Settings, month locks, report runs');
    const settings = await q(`SELECT key, value, updated_by_id::text AS by FROM app_settings`);
    const org = settings.find((s) => s.key === 'org');
    check("the 3.1 'org' and 'system' rows unchanged", (await one(`SELECT count(*)::int AS n FROM (SELECT * FROM rxv_before.app_settings EXCEPT SELECT * FROM app_settings) x`)).n === 0);
    check("org:<id> for each organisation = the 3.1 values (8 keys, no breakBufferMin)", F.live.every((c) => JSON.stringify(settings.find((s) => s.key === `org:${c}`)?.value) === JSON.stringify(org.value)) && Object.keys(org.value).length === 8,
      settings.map((s) => s.key));
    check('no settings for the deleted company', !settings.some((s) => s.key === `org:${F.C.c0}`));
    const locks = await one(`SELECT
        (SELECT count(*) FROM rxv_before.month_locks)::int AS before,
        (SELECT count(*) FROM month_locks)::int AS after,
        (SELECT count(*) FROM rxv_before.month_locks b CROSS JOIN companies c WHERE c.deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM month_locks l WHERE l.company_id = c.id AND l.month = b.month AND l.locked_by_id = b.locked_by_id AND l.locked_at = b.locked_at AND l.snapshot = b.snapshot))::int AS missing,
        (SELECT count(*) FROM month_locks l JOIN companies c ON c.id = l.company_id WHERE c.deleted_at IS NOT NULL)::int AS deleted_company`);
    check(`month locks: each 3.1 lock once per organisation (${F.live.length}), same locker, time and snapshot`, locks.after === locks.before * F.live.length && locks.missing === 0 && locks.deleted_company === 0, locks);
    const runs = await one(`SELECT
        (SELECT count(*) FROM rxv_before.report_runs)::int AS before,
        (SELECT count(*) FROM report_runs)::int AS after,
        (SELECT count(*) FROM rxv_before.report_runs b CROSS JOIN companies c WHERE c.deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM report_runs r WHERE r.id = md5('rxv-run-' || b.id::text || c.id::text)::uuid AND r.company_id = c.id AND r.month = b.month
             AND r.scope = b.scope AND r.owner_id = b.owner_id AND r.generated_at = b.generated_at AND r.summary = b.summary))::int AS missing`);
    check(`report runs: each 3.1 run once per organisation (${F.live.length}), same month, scope, owner and summary`, runs.after === runs.before * F.live.length && runs.missing === 0, runs);
    const keys = await one(`SELECT
        (SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
          WHERE t.relname = 'month_locks' AND i.indisprimary) AS lock_pk,
        (SELECT indexdef FROM pg_indexes WHERE indexname = 'report_runs_company_id_month_scope_owner_id_key') AS run_key,
        (SELECT count(*) FROM pg_indexes WHERE indexname = 'report_runs_month_scope_owner_id_key')::int AS old_key,
        (SELECT string_agg(table_name || '.' || is_nullable, ',' ORDER BY table_name) FROM information_schema.columns WHERE column_name = 'company_id' AND table_name IN ('month_locks', 'report_runs') AND table_schema = '${SCHEMA}') AS nullable`);
    check('keys: month_locks (company_id, month); report_runs unique (company_id, month, scope, owner_id); the 3.1 key gone; company_id required',
      keys.lock_pk === 'company_id,month' && /UNIQUE INDEX .*\(company_id, month, scope, owner_id\)/.test(keys.run_key ?? '') && keys.old_key === 0 && keys.nullable === 'month_locks.NO,report_runs.NO', keys);
    const dupKeys = await one(`SELECT (SELECT count(*) FROM (SELECT company_id, month FROM month_locks GROUP BY 1, 2 HAVING count(*) > 1) x)::int AS locks,
      (SELECT count(*) FROM (SELECT company_id, month, scope, owner_id FROM report_runs GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) x)::int AS runs`);
    check('keys unique', dupKeys.locks === 0 && dupKeys.runs === 0, dupKeys);
    if (two) {
      const foreignRuns = await q(`SELECT r.scope, u.email, r.month FROM report_runs r JOIN users u ON u.id = r.owner_id JOIN roles ro ON ro.id = u.role_id
        WHERE ro.name <> 'SUPER_ADMIN' AND r.company_id IS DISTINCT FROM u.company_id ORDER BY 2, 3`);
      console.log(`  note: ${foreignRuns.length} TEAM run(s) copied into an organisation their Manager is not in: ${foreignRuns.map((r) => `${r.email.split('@')[0]} ${r.month}`).join(', ')}`);
    }

    console.log('\n# Approvals');
    const pendCount = async (schema) => one(`SELECT (SELECT count(*) FROM ${schema}.break_records WHERE approval_status = 'PENDING')::int AS breaks, (SELECT count(*) FROM ${schema}.meeting_records WHERE approval_status = 'PENDING')::int AS meetings`);
    const [pb, pa] = [await pendCount('rxv_before'), await pendCount(SCHEMA)];
    check('pending items: the same number before and after', pb.breaks === pa.breaks && pb.meetings === pa.meetings, { before: pb, after: pa });
    for (const t of ['break_records', 'meeting_records']) {
      const r = await one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE b.approval_status = 'PENDING' AND b.approver_role::text = 'SUPER_ADMIN')::int AS moved
        FROM rxv_before.${t} b JOIN ${t} a USING (id)
        WHERE a.approver_role::text IS DISTINCT FROM (CASE WHEN b.approval_status = 'PENDING' AND b.approver_role::text = 'SUPER_ADMIN' THEN 'ADMIN' ELSE b.approver_role::text END)`);
      check(`${t}: pending SUPER_ADMIN -> ADMIN; MANAGER, decided and NOT_REQUIRED rows keep their route`, r.n === 0, r);
    }
    const route = async (t, id) => (await one(`SELECT approver_role::text AS role, approver_id::text AS approver, approval_status::text AS status FROM ${t} WHERE id = $1::uuid`, id));
    check("a Staff member's item routed to their Super Admin manager: ADMIN pool, approver kept", (await route('break_records', F.B.pendSaStaff)).role === 'ADMIN' && (await route('break_records', F.B.pendSaStaff)).approver === F.U.sa1);
    check("a Manager's own item and a pending skip: ADMIN pool", (await route('break_records', F.B.pendSaMgr)).role === 'ADMIN' && (await route('break_records', F.B.skipPendSa)).role === 'ADMIN' && (await route('meeting_records', F.M.mPendSa)).role === 'ADMIN');
    check('items routed to a Manager stay with the Manager', (await route('break_records', F.B.pendMgr)).role === 'MANAGER' && (await route('break_records', F.B.skipPendMgr)).approver === F.U.m2 && (await route('meeting_records', F.M.mPendMgr)).role === 'MANAGER');
    check('decided items keep SUPER_ADMIN', (await route('break_records', F.B.apprSa)).role === 'SUPER_ADMIN' && (await route('meeting_records', F.M.mApprSa)).role === 'SUPER_ADMIN');
    const cols31 = {
      users: ['email', 'password_hash', 'first_name', 'last_name', 'designation', 'department', 'status', 'role_id', 'manager_id', 'shift_id', 'shift_start', 'shift_end', 'agent_activated_at', 'created_at', 'updated_at', 'deleted_at', 'screenshots_enabled'],
      break_records: ['user_id', 'date', 'kind', 'seq', 'presence_type', 'shift_id', 'shift_name', 'scheduled_start', 'duration_min', 'window_open', 'window_close', 'ring_start', 'ring_end', 'presence_session_id', 'started_at', 'timing', 'minutes_off', 'reason', 'overrun_reason', 'source', 'approval_status', 'approver_id', 'decided_by_id', 'decided_at', 'decision_note', 'created_at', 'updated_at', 'commented_at', 'due_at', 'escalated_at', 'outcome', 'overrun_asked', 'overrun_sec', 'reminded_at'],
      meeting_records: ['user_id', 'date', 'mode', 'agenda', 'participants', 'started_at', 'ended_at', 'duration_sec', 'presence_session_id', 'approval_status', 'approver_id', 'decided_by_id', 'decided_at', 'decision_note', 'due_at', 'escalated_at', 'reminded_at', 'created_at', 'updated_at'],
    };
    for (const [t, cols] of Object.entries(cols31)) {
      const r = await one(`SELECT (SELECT count(*) FROM rxv_before.${t})::int AS before, (SELECT count(*) FROM ${t})::int AS after,
        (SELECT count(*) FROM rxv_before.${t} b JOIN ${t} a USING (id) WHERE ROW(${cols.map((c) => `a."${c}"`).join(', ')}) IS DISTINCT FROM ROW(${cols.map((c) => `b."${c}"`).join(', ')}))::int AS changed`);
      check(`${t}: every 3.1 column but the moved one unchanged, no row lost or added (soft-deleted rows included)`, r.before === r.after && r.changed === 0, r);
    }
    if (two) {
      const orphanPending = await q(`SELECT u.email, t.approver_role::text AS role FROM (SELECT user_id, approver_role FROM break_records WHERE approval_status = 'PENDING' UNION ALL SELECT user_id, approver_role FROM meeting_records WHERE approval_status = 'PENDING') t
        JOIN users u ON u.id = t.user_id WHERE u.company_id IS NULL`);
      console.log(`  note: ${orphanPending.length} pending item(s) of people with no organisation, reachable by nobody until the person is placed: ${orphanPending.map((p) => `${p.email.split('@')[0]} (${p.role})`).join(', ')}`);
    }

    console.log('\n# Break segments');
    const seg = await one(`WITH exp AS (SELECT b.id AS bid, p.id AS pid, p.started_at, p.ended_at FROM break_records b JOIN presence_sessions p ON p.id = b.presence_session_id WHERE b.outcome = 'TAKEN')
      SELECT (SELECT count(*) FROM exp)::int AS expected, (SELECT count(*) FROM break_segments)::int AS segments,
        (SELECT count(*) FROM exp e WHERE NOT EXISTS (SELECT 1 FROM break_segments s WHERE s.break_record_id = e.bid AND s.presence_session_id = e.pid AND s.started_at = e.started_at AND s.ended_at IS NOT DISTINCT FROM e.ended_at))::int AS missing,
        (SELECT count(*) FROM (SELECT break_record_id FROM break_segments GROUP BY 1 HAVING count(*) > 1) x)::int AS several,
        (SELECT count(*) FROM break_segments s JOIN break_records b ON b.id = s.break_record_id WHERE b.outcome <> 'TAKEN')::int AS on_skips,
        (SELECT count(*) FROM break_segments s WHERE s.id <> md5('rxv-seg-' || s.break_record_id::text)::uuid)::int AS other_ids`);
    check('one segment per taken break, with the times of its presence session; none for skips', seg.expected === seg.segments && seg.missing === 0 && seg.several === 0 && seg.on_skips === 0 && seg.other_ids === 0, seg);
    const state = await one(`SELECT count(*)::int AS wrong,
        count(*) FILTER (WHERE b.state = 'ACTIVE')::int AS active, count(*) FILTER (WHERE b.outcome <> 'TAKEN')::int AS skips
      FROM break_records b LEFT JOIN presence_sessions p ON p.id = b.presence_session_id
      WHERE NOT (CASE WHEN b.outcome = 'TAKEN' AND p.id IS NOT NULL THEN
          (p.ended_at IS NULL AND b.state = 'ACTIVE' AND b.ended_at IS NULL AND b.taken_sec IS NULL)
          OR (p.ended_at IS NOT NULL AND b.state = 'ENDED' AND b.ended_at = p.ended_at AND b.taken_sec = GREATEST(0, round(extract(epoch FROM p.ended_at - p.started_at)))::int)
        ELSE b.state = 'ENDED' AND b.ended_at IS NULL AND b.taken_sec IS NULL END)`);
    check('state, ended_at and taken_sec: ENDED with the length when closed, ACTIVE when open, untouched for skips', state.wrong === 0, state);
    const open = await one(`SELECT b.state::text AS state, s.ended_at IS NULL AS open FROM break_records b JOIN break_segments s ON s.break_record_id = b.id WHERE b.id = $1::uuid`, F.B.openBreak);
    check('the break open at migration time: one open segment, ACTIVE', open?.state === 'ACTIVE' && open.open === true, open);
    const s1d = await one(`SELECT b.state::text AS state, b.taken_sec AS taken, s.started_at, s.ended_at FROM break_records b JOIN break_segments s ON s.break_record_id = b.id WHERE b.id = $1::uuid`, F.B[`s1:${F.s1Expected[1].date}:LUNCH`]);
    check('the 42-minute lunch: ENDED, taken_sec 2520', s1d?.state === 'ENDED' && s1d.taken === 2520, s1d);

    console.log('\n# Untouched tables and references');
    const untouchedAfter = await tableHash(UNTOUCHED);
    const differ = UNTOUCHED.filter((t) => untouchedBefore[t] !== untouchedAfter[t]);
    check(`untouched tables identical, row for row (${UNTOUCHED.length} tables)`, differ.length === 0, differ.map((t) => ({ t, before: untouchedBefore[t], after: untouchedAfter[t] })));
    if (!two) {
      const sb = await one(`SELECT count(*)::int AS n FROM (SELECT * FROM rxv_before.shift_breaks EXCEPT SELECT * FROM shift_breaks) x`);
      check('A: shift_breaks identical', sb.n === 0 && (await one(`SELECT count(*)::int AS n FROM shift_breaks`)).n === (await one(`SELECT count(*)::int AS n FROM rxv_before.shift_breaks`)).n, sb);
    } else {
      const sb = await one(`SELECT count(*)::int AS n FROM (SELECT * FROM rxv_before.shift_breaks EXCEPT SELECT * FROM shift_breaks) x`);
      check('B: the original shift_breaks rows unchanged', sb.n === 0, sb);
    }
    const orphans = await one(`SELECT
        (SELECT count(*) FROM report_runs r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.owner_id))::int AS run_owner,
        (SELECT count(*) FROM month_locks l WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.locked_by_id))::int AS lock_by,
        (SELECT count(*) FROM app_settings s WHERE s.key LIKE 'org:%' AND NOT EXISTS (SELECT 1 FROM companies c WHERE 'org:' || c.id::text = s.key AND c.deleted_at IS NULL))::int AS settings_org,
        (SELECT count(*) FROM users u JOIN departments d ON d.id = u.department_id WHERE d.company_id IS DISTINCT FROM u.company_id)::int AS user_dept_company,
        (SELECT count(*) FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.deleted_at IS NOT NULL)::int AS dept_deleted_company,
        (SELECT count(*) FROM break_records b WHERE (b.approver_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.approver_id)) OR (b.decided_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.decided_by_id)))::int AS break_people,
        (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated)::int AS unvalidated_fks`);
    check('no orphan references (columns without a foreign key, cross-company links)', Object.values(orphans).every((n) => n === 0), orphans);

    // ---- Idempotency --------------------------------------------------------------------------------
    console.log('\n# The backfill again, by hand (psql, one transaction)');
    const AFFECTED = ['roles', 'companies', 'users', 'shifts', 'shift_breaks', 'shift_assignments', 'departments', 'manager_departments', 'app_settings', 'month_locks', 'report_runs', 'break_records', 'meeting_records', 'break_segments'];
    const schemaState = async () => (await one(`SELECT md5(string_agg(indexdef, ';' ORDER BY indexname)) AS i FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename IN ('month_locks', 'report_runs', 'departments', 'break_segments')`)).i +
      (await one(`SELECT md5(string_agg(conname || pg_get_constraintdef(oid), ';' ORDER BY conname)) AS c FROM pg_constraint WHERE conrelid IN ('${SCHEMA}.month_locks'::regclass, '${SCHEMA}.report_runs'::regclass)`)).c;
    const firstState = { ...(await tableHash(AFFECTED)), schema: await schemaState() };
    const t0 = Date.now();
    let rerunError = null;
    try {
      psql(name, ['--single-transaction', '-f', BACKFILL_SQL]);
    } catch (e) {
      rerunError = e.message;
    }
    const rerunMs = Date.now() - t0;
    check('a second run succeeds', rerunError === null, rerunError);
    const secondState = { ...(await tableHash(AFFECTED)), schema: await schemaState() };
    const moved = Object.keys(firstState).filter((k) => firstState[k] !== secondState[k]);
    check(`a second run changes nothing (${AFFECTED.length} tables, keys and indexes; ${rerunMs} ms)`, moved.length === 0, moved);

    // ---- Boot -----------------------------------------------------------------------------------------
    if (BOOT) await bootCheck(sc, name, F, q, one, work);
    else console.log('\n# Boot check skipped (BOOT=0)');
  } finally {
    await stopApi();
    await db?.$disconnect().catch(() => {});
    dropDb(name);
    rmSync(work, { recursive: true, force: true });
    live.dirs.delete(work);
    const left = psql('postgres', ['-At', '-c', `SELECT count(*) FROM pg_database WHERE datname = '${name}'`]).trim();
    check(`scratch database ${name} dropped`, left === '0', left);
  }
}

// =====================================================================================
// The built API on the migrated database
// =====================================================================================
async function stopApi() {
  const api = live.api;
  if (!api || api.exitCode !== null) return;
  api.kill('SIGTERM');
  const done = await Promise.race([new Promise((r) => api.once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 10_000))]);
  if (!done) api.kill('SIGKILL');
  live.api = null;
}

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

async function bootCheck(sc, name, F, q, one, work) {
  const two = sc === 'B';
  console.log(`\n# The built API on the migrated database (port ${PORT})`);
  const main = join(BACKEND, 'dist', 'main.js');
  if (!existsSync(main) || statSync(main).mtimeMs < newestMtime(join(BACKEND, 'src'))) {
    check('dist/main.js is built from the current src (run `npx nest build` first)', false, { exists: existsSync(main) });
    return;
  }
  // backend/node_modules may be a symlink to another checkout: module-alias would then map
  // @shared and @modules to that checkout's dist. --preserve-symlinks keeps them here.
  const node = ['--preserve-symlinks', '--preserve-symlinks-main'];
  const resolved = spawnSync(process.execPath, [...node, '-e', "require('module-alias/register'); process.stdout.write(require.resolve('@shared/config/configuration'))"], { cwd: BACKEND, encoding: 'utf8' }).stdout;
  if (!resolved.startsWith(join(BACKEND, 'dist'))) {
    check('@shared resolves to this checkout\'s dist', false, resolved);
    return;
  }
  const busy = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (busy) {
    check(`port ${PORT} is free (something already answers there; not touching it)`, false);
    return;
  }

  // Known passwords for the accounts the checks sign in with, hashed like the API (bcrypt, BCRYPT_SALT_ROUNDS, default 12).
  const bcrypt = (await import('bcrypt')).default;
  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 12);
  const pw = `Mig40-${randomBytes(12).toString('base64url')}`;
  const hash = await bcrypt.hash(pw, rounds);
  await q(`UPDATE users SET password_hash = $1 WHERE id = ANY($2::uuid[]) RETURNING id`, hash, [F.U.sa1, F.U.m1]);

  const secret = () => randomBytes(32).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), DATABASE_URL: urlOf(name),
    APP_TIMEZONE: TZ, JWT_ACCESS_SECRET: secret(), JWT_REFRESH_SECRET: secret(), JWT_ENROLL_SECRET: secret(), LOG_LEVEL: 'warn',
    CORS_ORIGINS: 'http://localhost:3000', RATE_LIMIT_MAX: '1000', SWAGGER_ENABLED: 'false', METRICS_ENABLED: 'false', BCRYPT_SALT_ROUNDS: String(rounds),
    // Nothing from a .env next to it may reach S3: empty values win over the file.
    AWS_BUCKET: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AGENT_S3_BUCKET: '', AGENT_S3_KEY: '', AGENT_MAC_S3_KEY: '', AGENT_MAC_X64_S3_KEY: '',
  };
  const logFile = join(work, 'api.log');
  const log = openSync(logFile, 'a');
  const t0 = Date.now();
  live.api = spawn(process.execPath, [...node, 'dist/main.js'], { cwd: BACKEND, env, stdio: ['ignore', log, log] });
  let up = false;
  while (!up && Date.now() - t0 < 90_000 && live.api.exitCode === null) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json()).then((b) => b?.data?.db === 'up' || b?.db === 'up', () => false);
  }
  check(`API up on the migrated database, /health db up (${((Date.now() - t0) / 1000).toFixed(1)} s)`, up, up ? undefined : scrub(readFileSync(logFile, 'utf8').slice(-1500)));
  if (!up) return;

  const data = (r) => r.body?.data;
  const C1 = F.C.c1;
  const saC = await new Client('superadmin').login('sa1@mig40.test', pw);
  let r = await saC.get('/me');
  check('GET /me, migrated Super Admin: no organisation until one is chosen', data(r)?.role === 'SUPER_ADMIN' && data(r)?.organisation === null && data(r)?.permissions?.needsOrganisation === true, data(r));
  r = await saC.get('/settings');
  check('GET /settings without an organisation: 400 ORG_REQUIRED', r.status === 400 && r.body?.error?.code === 'ORG_REQUIRED', r.body);
  r = await saC.get('/organisations');
  const orgs = data(r) ?? [];
  check(`GET /organisations: ${F.live.length} organisation(s), the deleted company not listed`, orgs.length === F.live.length && F.live.every((c) => orgs.some((o) => o.id === c)), orgs);
  r = await saC.get('/overview/platform');
  const unassigned = (await one(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.deleted_at IS NULL AND r.name <> 'SUPER_ADMIN' AND (u.company_id IS NULL OR c.deleted_at IS NOT NULL)`)).n;
  const ov = data(r);
  const counts = await one(`SELECT count(*) FILTER (WHERE r.name = 'USER')::int AS staff, count(*) FILTER (WHERE r.name = 'MANAGER')::int AS managers,
    (SELECT count(*) FROM departments WHERE company_id = $1::uuid AND deleted_at IS NULL)::int AS departments FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = $1::uuid AND u.deleted_at IS NULL`, C1);
  const c1 = ov?.organisations?.find((o) => o.id === C1);
  check(`GET /overview/platform: ${unassigned} unassigned, C1 with no Admin and the counts of the database`, ov?.unassignedPeople === unassigned && (two ? unassigned === 3 : unassigned === 0) && c1?.admin === null &&
    c1?.counts?.staff === counts.staff && c1?.counts?.managers === counts.managers && c1?.counts?.departments === counts.departments, { unassigned: ov?.unassignedPeople, c1, counts });

  saC.headers['X-Org-Id'] = C1;
  r = await saC.get('/me');
  check('GET /me with X-Org-Id: the organisation is chosen', data(r)?.organisation?.id === C1 && data(r)?.permissions?.needsOrganisation === false, data(r)?.organisation);
  r = await saC.get('/settings');
  const s = data(r);
  check('GET /settings: the 3.1 values and breakBufferMin 10', r.status === 200 && Object.entries(F.org31).every(([k, v]) => s?.[k] === v) && s?.breakBufferMin === 10, s);
  r = await saC.get('/departments');
  const apiDepts = data(r) ?? [];
  const dbDepts = await q(`SELECT d.id::text, d.name,
      (SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.department_id = d.id AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND r.name = 'USER')::int AS staff,
      (SELECT string_agg(md.manager_id::text, ',' ORDER BY md.manager_id) FROM manager_departments md JOIN users m ON m.id = md.manager_id WHERE md.department_id = d.id AND m.deleted_at IS NULL) AS managers
    FROM departments d WHERE d.company_id = $1::uuid AND d.deleted_at IS NULL`, C1);
  const deptOk = dbDepts.length === apiDepts.length && dbDepts.every((d) => {
    const a = apiDepts.find((x) => x.id === d.id);
    return a && a.name === d.name && a.staffCount === d.staff && a.managers.map((m) => m.id).sort().join(',') === (d.managers ?? '');
  });
  check('GET /departments (Super Admin, C1): the migrated departments, Staff counts and Managers', r.status === 200 && deptOk, { api: apiDepts.map((d) => `${d.name} ${d.staffCount} [${d.managers.map((m) => m.name)}]`), db: dbDepts });

  const s1Path = `/reports/person/${F.U.s1}/month`;
  const expFocus = F.s1Expected.reduce((n, d) => n + d.focusSec, 0);
  const checkMonth = (who, rep) => {
    const days = rep?.days ?? [];
    const byDate = new Map(days.map((d) => [d.date, d]));
    const perDay = F.s1Expected.filter((e) => byDate.get(e.date)?.focusSec !== e.focusSec);
    check(`${who}: S1's month (3.1 history) has the 3.1 focus, day by day (${expFocus} s)`, rep?.totals?.focusSec === expFocus && perDay.length === 0 && rep?.locked === false,
      { total: rep?.totals?.focusSec, expected: expFocus, days: perDay.map((e) => ({ date: e.date, label: e.label, got: byDate.get(e.date)?.focusSec, want: e.focusSec })) });
    const split = F.s1Expected.filter((e) => byDate.get(e.date)?.paidBreakSec !== e.paidBreakSec || byDate.get(e.date)?.unpaidBreakSec !== e.unpaidBreakSec);
    check(`${who}: paid and unpaid break time of 3.1 days (scheduled length paid, overruns out of the 10-minute buffer)`, split.length === 0,
      split.map((e) => ({ date: e.date, label: e.label, paid: byDate.get(e.date)?.paidBreakSec, wantPaid: e.paidBreakSec, unpaid: byDate.get(e.date)?.unpaidBreakSec, wantUnpaid: e.unpaidBreakSec })));
  };
  r = await saC.get(`${s1Path}?month=${LM}`);
  check(`GET ${'/reports/person/:id/month'}?month=${LM} (Super Admin, C1) [200]`, r.status === 200, r.body);
  checkMonth('Super Admin', data(r));
  r = await saC.get(`${s1Path}?month=${LLM}`);
  const locked = data(r);
  check(`a month 3.1 locked (${LLM}): read from the snapshot copied to C1, focus ${F.lockedFocus} s`, r.status === 200 && locked?.locked === true && locked?.totals?.focusSec === F.lockedFocus, { status: r.status, locked: locked?.locked, focus: locked?.totals?.focusSec });
  const missing40 = ['targetSec', 'paidBreakSec', 'unpaidBreakSec'].filter((k) => locked?.totals?.[k] === undefined);
  console.log(`  note: the locked 3.1 snapshot is served as stored; 4.0 fields absent from its totals: ${missing40.join(', ') || 'none'}`);
  if (two) {
    // The 3.1 lock (one snapshot of everyone) is copied to C2 as well: C2 must see only its own people.
    const C2 = F.C.c2;
    saC.headers['X-Org-Id'] = C2;
    r = await saC.get('/departments');
    const c2Depts = (await q(`SELECT id::text FROM departments WHERE company_id = $1::uuid AND deleted_at IS NULL`, C2)).map((d) => d.id).sort();
    check('B: GET /departments with C2 chosen: only C2\'s departments', r.status === 200 && (data(r) ?? []).map((d) => d.id).sort().join() === c2Depts.join(), (data(r) ?? []).map((d) => d.name));
    r = await saC.get(`/reports/team/month?month=${LLM}`);
    const rows = data(r)?.rows ?? [];
    const c2People = new Set((await q(`SELECT id::text FROM users WHERE company_id = $1::uuid`, C2)).map((u) => u.id));
    check(`B: C2's copy of the ${LLM} lock: locked, and no row of anybody outside C2 (the snapshot holds C1's S1)`, r.status === 200 && data(r)?.locked === true && rows.every((x) => c2People.has(x.person?.id)), { status: r.status, people: rows.map((x) => x.person?.email) });
    r = await saC.get(`${s1Path}?month=${LLM}`);
    check("B: S1's locked month with C2 chosen: 404 (another organisation's person)", r.status === 404, { status: r.status });
    saC.headers['X-Org-Id'] = C1;
  }

  const mgr = await new Client('manager').login('m1@mig40.test', pw);
  r = await mgr.get('/me');
  const mDepts = (await q(`SELECT md.department_id::text AS id FROM manager_departments md WHERE md.manager_id = $1::uuid`, F.U.m1)).map((x) => x.id).sort();
  const me = data(r);
  check('GET /me, migrated Manager: their organisation and the departments the backfill gave them', me?.role === 'MANAGER' && me?.organisation?.id === C1 &&
    (me?.departments ?? []).map((d) => d.id).sort().join() === mDepts.join() && mDepts.length === 3, { departments: me?.departments?.map((d) => d.name), organisation: me?.organisation });
  r = await mgr.get('/departments');
  check('GET /departments (Manager): only theirs', r.status === 200 && (data(r) ?? []).map((d) => d.id).sort().join() === mDepts.join(), (data(r) ?? []).map((d) => d.name));
  r = await mgr.get(`${s1Path}?month=${LM}`);
  check(`GET /reports/person/:id/month (Manager of R&D) [200]`, r.status === 200, r.body);
  checkMonth('Manager', data(r));
  await stopApi();
  const errors = readFileSync(logFile, 'utf8').split('\n').filter((l) => /"level":(50|60)/.test(l));
  check('no error lines in the API log', errors.length === 0, errors.slice(0, 3).map(scrub));
}

// =====================================================================================
let crashed = null;
try {
  psql('postgres', ['-At', '-c', 'SELECT 1']);
  for (const sc of SCENARIOS) {
    if (!['A', 'B'].includes(sc)) throw new Error(`unknown scenario ${sc}`);
    await scenario(sc);
  }
} catch (e) {
  crashed = e;
  check(`the run completed (${scrub(e.message).slice(0, 300)})`, false);
  console.error(scrub(e.stack ?? e.message));
} finally {
  cleanupNow();
}
if (timings.length) {
  console.log('\n# Migration times (ms in the database / with Prisma)');
  for (const t of timings) {
    console.log(`  ${t.scenario}${t.volume ? ` VOLUME=${t.volume}` : ''} (${t.samples} samples, ${t.breaks} break records): ` +
      V40.map((m, i) => `${m.replace('20261020_', '')} ${t.db[i]}/${t.wall[i]}`).join(', ') + `; total ${t.wall.reduce((a, b) => a + b, 0)} ms`);
  }
}
summary();
if (crashed) process.exitCode = 1;
