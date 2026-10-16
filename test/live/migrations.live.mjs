// The two 3.1 migrations on 3.0 data, applied by Prisma the way a deployment does.
// Builds a scratch database next to the local one (DATABASE_URL, localhost only),
// applies the 3.0 migrations, writes 3.0 rows for every backfill case, applies
// 20261014_focus_meetings_reports and 20261014_focus_meetings_reports_backfill
// one at a time (timed), checks the result and drops the scratch database.
// No API needed. VOLUME=5 adds about 5 million activity samples to time the backfill.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, summary } from './lib.mjs';
import { localDatabaseUrl } from './db.mjs';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(BACKEND, 'prisma', 'migrations');
const PRISMA = join(BACKEND, 'node_modules', '.bin', 'prisma');
const DDL = '20261014_focus_meetings_reports';
const BACKFILL = '20261014_focus_meetings_reports_backfill';
const VOLUME = Number(process.env.VOLUME ?? 0);

// The backfill's business day is Asia/Kolkata (fixed +05:30), like the migration.
const dayKey = (offset = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offset * 86_400_000));
const ist = (date, hm) => new Date(`${date}T${hm}:00+05:30`);
/** Timestamps go in as ISO text: the columns are timestamp(3) holding UTC. */
const iso = (at) => (at ? at.toISOString() : null);
const TS = (n) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The id the backfill gives a (user, date) session: md5 shaped as a v4 UUID. */
const sessionId = (userId, date) => {
  const h = createHash('md5').update(`work_session:${userId}:${date}`).digest('hex').split('');
  h[12] = '4';
  h[16] = '8';
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

const baseUrl = localDatabaseUrl();
const scratchUrl = new URL(baseUrl);
const scratchName = `rxv_migcheck_${process.pid}`;
scratchUrl.pathname = `/${scratchName}`;
const { PrismaClient } = await import('@prisma/client');
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const work = mkdtempSync(join(tmpdir(), 'rxv-migcheck-'));
mkdirSync(join(work, 'migrations'));
writeFileSync(join(work, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n');
cpSync(join(MIGRATIONS, 'migration_lock.toml'), join(work, 'migrations', 'migration_lock.toml'));

/** Copies migrations into the scratch folder and runs `prisma migrate deploy`; ms taken. */
function deploy(names) {
  for (const n of names) cpSync(join(MIGRATIONS, n), join(work, 'migrations', n), { recursive: true });
  const t0 = Date.now();
  execFileSync(PRISMA, ['migrate', 'deploy', '--schema', join(work, 'schema.prisma')], {
    cwd: work,
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    stdio: 'pipe',
  });
  return Date.now() - t0;
}

let db = null;
try {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  const before = readdirSync(MIGRATIONS).filter((n) => /^\d/.test(n) && n < DDL).sort();
  deploy(before);
  db = new PrismaClient({ datasources: { db: { url: scratchUrl.toString() } } });
  const sql = (q, ...v) => db.$executeRawUnsafe(q, ...v);

  console.log('\n# 3.0 data');
  const roleOf = async (name) => (await db.$queryRawUnsafe(`SELECT id::text FROM roles WHERE name = '${name}'`))[0].id;
  const [userRole, mgrRole] = [await roleOf('USER'), await roleOf('MANAGER')];
  const A = randomUUID();
  const B = randomUUID();
  const M = randomUUID();
  for (const [id, role, email] of [[A, userRole, 'a'], [B, userRole, 'b'], [M, mgrRole, 'm']]) {
    await sql(`INSERT INTO users (id, email, password_hash, first_name, last_name, role_id, updated_at)
               VALUES ($1::uuid, $2, 'x', 'T', $2, $3::uuid, now())`, id, `${email}@migcheck.test`, role);
  }
  const d = (n) => dayKey(-n);
  const today = d(0);
  const day = async (user, date, loginAt, endedAt) =>
    sql(`INSERT INTO work_day_ends (id, user_id, date, login_at, ended_at) VALUES ($1::uuid, $2::uuid, $3, ${TS(4)}, ${TS(5)})`,
      randomUUID(), user, date, iso(loginAt), iso(endedAt));
  const sample = async (user, date, at, idle) =>
    sql(`INSERT INTO activity_samples (id, user_id, date, at, duration_sec, idle, app) VALUES ($1::uuid, $2::uuid, $3, ${TS(4)}, 60, $5, 'EXCEL.EXE')`,
      randomUUID(), user, date, iso(at), idle);
  await day(A, d(4), ist(d(4), '09:35'), ist(d(4), '18:40')); // End Day: USER
  await day(A, d(2), ist(d(2), '09:30'), null); // no End Day: last input 16:00
  await sample(A, d(2), ist(d(2), '09:31'), false);
  await sample(A, d(2), ist(d(2), '16:00'), false);
  await sample(A, d(2), ist(d(2), '17:30'), true);
  await day(A, d(3), ist(d(3), '10:00'), ist(d(3), '09:00')); // End Day before login: skipped
  await day(M, d(2), ist(d(2), '09:50'), null); // no End Day, no input: skipped
  await day(B, d(5), ist(d(5), '09:00'), ist(addDays(d(5), 1), '10:00')); // End Day next morning: 14 h
  await day(B, d(6), ist(d(6), '09:00'), null); // last input 23:50: 14 h
  await sample(B, d(6), ist(d(6), '23:50'), false);
  await day(B, d(1), null, ist(d(1), '18:00')); // no login: skipped
  await day(A, today, new Date(Date.now() - 3_600_000), null); // today: left to the server
  await day(B, d(7), ist(d(7), '09:10'), ist(d(7), '18:10')); // already has a session (below): never twice

  // Shifts as 3.0 leaves them: the 2-minute overrun grace (the 20261013 default),
  // and one a Super Admin set to 5. "Edited" and its lunch change after the schema
  // migration (below): an earlier run of this backfill must not undo them.
  const NOW_UTC = `(now() AT TIME ZONE 'UTC')`;
  const shift = randomUUID();
  const custom = randomUUID();
  const edited = randomUUID();
  for (const [id, name, grace] of [[shift, 'Day', 2], [custom, 'Custom', 5], [edited, 'Edited', 3]]) {
    await sql(`INSERT INTO shifts (id, name, start, "end", overrun_grace_min, updated_at)
               VALUES ($1::uuid, $2, '09:30', '18:30', $3, ${NOW_UTC})`, id, name, grace);
  }
  const editedLunch = randomUUID();
  for (const [id, sh, kind, start, len] of [
    [randomUUID(), shift, 'MORNING', '11:00', 15],
    [randomUUID(), shift, 'LUNCH', '13:00', 30],
    [editedLunch, edited, 'LUNCH', '13:00', 30],
  ]) {
    await sql(`INSERT INTO shift_breaks (id, shift_id, kind, start_time, duration_min, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::"BreakKind", $4, $5, ${NOW_UTC})`, id, sh, kind, start, len);
  }
  const br = {};
  const brk = async (key, user, date, kind, startHm, len, { endHm, status = 'NOT_REQUIRED', reason = null, overrun = null, open = false }) => {
    const ps = randomUUID();
    const started = ist(date, startHm);
    await sql(`INSERT INTO presence_sessions (id, user_id, type, date, started_at, ended_at, updated_at)
               VALUES ($1::uuid, $2::uuid, 'BREAK', $3, ${TS(4)}, ${TS(5)}, now())`, ps, user, date, iso(started), open ? null : iso(ist(date, endHm)));
    br[key] = randomUUID();
    await sql(`INSERT INTO break_records (id, user_id, date, kind, presence_type, presence_session_id, started_at, duration_min,
                 timing, reason, overrun_reason, approval_status, approver_role, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3, $4::"BreakKind", 'BREAK', $5::uuid, ${TS(6)}, $7, 'ON_TIME', $8, $9,
                 $10::"BreakApprovalStatus", CASE WHEN $10 = 'NOT_REQUIRED' THEN NULL ELSE 'MANAGER'::"RoleName" END, ${TS(6)}, now())`,
      br[key], user, date, kind, ps, iso(started), len, reason, overrun, status);
  };
  await brk('pendingLate', A, d(2), 'MORNING', '11:20', 15, { endHm: '11:35', status: 'PENDING', reason: 'Customer call' });
  await brk('approvedLate', A, d(4), 'MORNING', '11:20', 15, { endHm: '11:35', status: 'APPROVED', reason: 'Customer call' });
  await brk('approvedOverrun', A, d(4), 'LUNCH', '13:00', 30, { endHm: '13:42', status: 'APPROVED', overrun: 'Long call' });
  await brk('quietOverrun', A, d(2), 'LUNCH', '13:00', 30, { endHm: '13:31', overrun: 'Long call' });
  await brk('openOverrun', B, d(5), 'MORNING', '11:00', 15, { status: 'PENDING', overrun: 'Long call', open: true });
  await brk('rejectedShort', B, d(6), 'MORNING', '11:00', 15, { endHm: '11:10', status: 'REJECTED', overrun: 'Long call' });
  check('3.0 rows written', true);

  if (VOLUME > 0) {
    const people = 120;
    const days = Math.max(1, Math.ceil((VOLUME * 1e6) / (people * 510)));
    console.log(`  adding ${people} people x ${days} days x 510 samples...`);
    await sql(`INSERT INTO users (id, email, password_hash, first_name, last_name, role_id, updated_at)
               SELECT md5('v' || i)::uuid, 'v' || i || '@migcheck.test', 'x', 'V', i::text, $1::uuid, now()
               FROM generate_series(1, ${people}) i`, userRole);
    await sql(`CREATE TABLE vol AS
               SELECT u.id AS user_id, to_char(k, 'YYYY-MM-DD') AS date,
                      (k + time '03:30' + random() * interval '60 minutes')::timestamp(3) AS login_at, random() AS r
               FROM users u CROSS JOIN generate_series(current_date - ${days + 7}, current_date - 8, interval '1 day') k
               WHERE u.email LIKE 'v%'`);
    await sql(`INSERT INTO work_day_ends (id, user_id, date, login_at, ended_at)
               SELECT md5(user_id::text || date)::uuid, user_id, date, login_at,
                      CASE WHEN r < 0.75 THEN login_at + interval '9 hours' WHEN r < 0.95 THEN NULL
                           ELSE login_at + interval '22 hours' END FROM vol`);
    await sql(`INSERT INTO activity_samples (id, user_id, date, at, duration_sec, idle, app, title)
               SELECT md5(random()::text || clock_timestamp()::text)::uuid, v.user_id, v.date,
                      v.login_at + g * interval '1 minute', 60, g % 10 = 9, 'EXCEL.EXE', 'Claims batch ' || (g % 50)
               FROM vol v CROSS JOIN generate_series(0, 509) g`);
    await sql('DROP TABLE vol');
    await sql('VACUUM ANALYZE');
  }
  const [{ samples, days: attendance }] = await db.$queryRawUnsafe(
    'SELECT (SELECT count(*) FROM activity_samples)::int AS samples, (SELECT count(*) FROM work_day_ends)::int AS days');

  console.log('\n# The 3.1 migrations, one at a time');
  const ddlMs = deploy([DDL]);
  // As if an earlier version of the backfill had run, and a Super Admin had changed
  // things since: a session for B's day 7, "Edited" back to 2 minutes, its lunch skippable.
  const earlier = randomUUID();
  await sql(`INSERT INTO work_sessions (id, user_id, date, started_at, ended_at, end_reason, source, updated_at)
             VALUES ($1::uuid, $2::uuid, $3, ${TS(4)}, ${TS(5)}, 'USER', 'BACKFILL', ${NOW_UTC})`,
    earlier, B, d(7), iso(ist(d(7), '09:10')), iso(ist(d(7), '18:10')));
  await new Promise((r) => setTimeout(r, 50));
  await sql(`UPDATE shifts SET overrun_grace_min = 2, updated_at = ${NOW_UTC} WHERE id = $1::uuid`, edited);
  await sql(`UPDATE shift_breaks SET allow_skip = true, updated_at = ${NOW_UTC} WHERE id = $1::uuid`, editedLunch);
  const backfillMs = deploy([BACKFILL]);
  const runs = await db.$queryRawUnsafe(
    `SELECT migration_name AS name, (extract(epoch FROM finished_at - started_at) * 1000)::int AS ms, rolled_back_at IS NULL AS ok
     FROM _prisma_migrations WHERE migration_name LIKE '20261014%' ORDER BY started_at`);
  check('both applied, in order', runs.length === 2 && runs[0].name === DDL && runs[1].name === BACKFILL && runs.every((r) => r.ok), runs);
  console.log(`  ${samples} activity samples, ${attendance} attendance days`);
  console.log(`  ${DDL}: ${runs[0]?.ms} ms in the database (${ddlMs} ms with Prisma)`);
  console.log(`  ${BACKFILL}: ${runs[1]?.ms} ms in the database (${backfillMs} ms with Prisma)`);

  console.log('\n# Work sessions from 3.0 attendance');
  const sessions = await db.$queryRawUnsafe(
    `SELECT id::text, user_id::text AS "userId", date, started_at AS "startedAt", ended_at AS "endedAt", end_reason::text AS "endReason", source
     FROM work_sessions WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, date`, [A, B, M]);
  const find = (user, date) => sessions.filter((s) => s.userId === user && s.date === date);
  const one = (label, user, date, start, end, reason) => {
    const s = find(user, date);
    check(label, s.length === 1 && s[0].startedAt.getTime() === start.getTime() && s[0].endedAt.getTime() === end.getTime() &&
      s[0].endReason === reason && s[0].source === 'BACKFILL' && s[0].id === sessionId(user, date), s);
  };
  one('End Day: login to End Day (USER)', A, d(4), ist(d(4), '09:35'), ist(d(4), '18:40'), 'USER');
  one('no End Day: login to the last input (AUTO_CLOSED)', A, d(2), ist(d(2), '09:30'), ist(d(2), '16:00'), 'AUTO_CLOSED');
  one('End Day the next morning: 14 hours at most (AUTO_CLOSED)', B, d(5), ist(d(5), '09:00'), ist(d(5), '23:00'), 'AUTO_CLOSED');
  one('last input 23:50: 14 hours at most', B, d(6), ist(d(6), '09:00'), ist(d(6), '23:00'), 'AUTO_CLOSED');
  check('End Day before the login: skipped', find(A, d(3)).length === 0);
  check('no End Day and no input: skipped', find(M, d(2)).length === 0);
  check('no login: skipped', find(B, d(1)).length === 0);
  check('today is left to the server', find(A, today).length === 0);
  check('a day that already has a session gets no second one', find(B, d(7)).length === 1 && find(B, d(7))[0].id === earlier, find(B, d(7)));
  check('nothing else', sessions.length === 5, sessions.length);
  if (VOLUME > 0) {
    const [v] = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n, max(extract(epoch FROM ended_at - started_at))::int AS longest FROM work_sessions`);
    check('volume: a session per day with an end, none over 14 hours', v.n > 4 && v.longest <= 14 * 3600, v);
  }

  console.log('\n# Break records');
  const rows = new Map((await db.$queryRawUnsafe(
    `SELECT id::text, due_at AS "dueAt", overrun_asked AS asked, overrun_sec AS "overrunSec", outcome::text FROM break_records`)).map((r) => [r.id, r]));
  const r = (k) => rows.get(br[k]);
  const due = r('pendingLate')?.dueAt?.getTime() ?? 0;
  check('waiting items: 48 hours from now, not from when they were made', Math.abs(due - (Date.now() + 48 * 3_600_000)) < 10 * 60_000, r('pendingLate'));
  check('decided items: no clock', r('approvedLate')?.dueAt === null, r('approvedLate'));
  check('every 3.0 record is TAKEN', [...rows.values()].every((x) => x.outcome === 'TAKEN'));
  check('overrun with a reason, decided: asked, 12 min from the session', r('approvedOverrun')?.asked === true && r('approvedOverrun').overrunSec === 720, r('approvedOverrun'));
  check('overrun reason that needed no decision: untouched', r('quietOverrun')?.asked === false && r('quietOverrun').overrunSec === null, r('quietOverrun'));
  check('late start only: not an overrun ask', r('pendingLate')?.asked === false, r('pendingLate'));
  check('overrun on a session still open: asked, no length yet', r('openOverrun')?.asked === true && r('openOverrun').overrunSec === null && r('openOverrun').dueAt !== null, r('openOverrun'));
  check('rejected, back within the length: asked, 0 s', r('rejectedShort')?.asked === true && r('rejectedShort').overrunSec === 0, r('rejectedShort'));

  console.log('\n# Schema');
  const lunch = await db.$queryRawUnsafe(
    `SELECT kind::text, allow_skip AS "allowSkip" FROM shift_breaks WHERE shift_id = $1::uuid ORDER BY kind`, shift);
  check('lunch is not skippable, other breaks are', lunch.length === 2 && lunch.every((x) => x.allowSkip === (x.kind !== 'LUNCH')), lunch);
  const [kept] = await db.$queryRawUnsafe(`SELECT allow_skip AS "allowSkip" FROM shift_breaks WHERE id = $1::uuid`, editedLunch);
  check('a lunch made skippable after the schema migration stays skippable', kept?.allowSkip === true, kept);
  const graces = Object.fromEntries((await db.$queryRawUnsafe(
    `SELECT name, overrun_grace_min AS g FROM shifts WHERE id = ANY($1::uuid[])`, [shift, custom, edited])).map((x) => [x.name, x.g]));
  check('the 3.0 grace of 2 min becomes 3; a chosen 5 stays; a 2 chosen after the schema migration stays',
    graces.Day === 3 && graces.Custom === 5 && graces.Edited === 2, graces);
  const [tmp] = await db.$queryRawUnsafe(`SELECT to_regclass('rxv_schema_applied')::text AS t`);
  check('the backfill leaves no helper table behind', tmp?.t === null, tmp);
  const idx = await db.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE indexname = 'work_sessions_one_open_per_user'`);
  check('one open session per person (partial unique index)', /UNIQUE.*WHERE \(ended_at IS NULL\)/.test(idx[0]?.indexdef ?? ''), idx);
  const [grace] = await db.$queryRawUnsafe(
    `SELECT column_default FROM information_schema.columns WHERE table_name = 'shifts' AND column_name = 'overrun_grace_min'`);
  check('overrun grace defaults to 3 min', grace?.column_default === '3', grace);

  console.log('\n# The backfill again');
  // Every row the backfill writes or changes, as one fingerprint.
  const state = async () => (await db.$queryRawUnsafe(
    `SELECT concat_ws('|', (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM work_sessions t),
                           (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM shifts t),
                           (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM shift_breaks t),
                           (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM break_records t)) AS f`))[0].f;
  const first = await state();
  execFileSync(PRISMA, ['db', 'execute', '--file', join(MIGRATIONS, BACKFILL, 'migration.sql'), '--schema', join(work, 'schema.prisma')], {
    cwd: work,
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    stdio: 'pipe',
  });
  check('running it a second time changes nothing', (await state()) === first);
} finally {
  await db?.$disconnect();
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}"`).catch((e) => console.error(`  could not drop ${scratchName}: ${e.message}`));
  await admin.$disconnect();
  rmSync(work, { recursive: true, force: true });
}
summary();
