#!/usr/bin/env node
// Sets every shift's hours, working days and break times from one JSON file,
// through the API (so the API's own validation applies), for one organisation.
// 4.0: run it as the organisation's Admin, or as a Super Admin with --org <id>.
//
// Why: after the 3.0 database update a 2.x shift keeps its name and hours but has
// no break times, so nobody gets a break ring and nothing can be skipped until
// each shift is set. This does it in one step on deploy day, or at any later time.
//
// Usage (Node 18 or later, from backend/):
//   RXV_ADMIN_EMAIL=<admin email> RXV_ADMIN_PASSWORD=<password> \
//     node scripts/configure-shifts.mjs --api https://<api-host>/api/v1 --file shifts.json [--dry-run]
//   A Super Admin adds --org <organisation id> (run without it to list the organisations).
//
// shifts.json (see scripts/shifts.example.json):
//   {
//     "default": "General",
//     "shifts": [
//       { "name": "General", "start": "09:30", "end": "18:30", "workDays": [1,2,3,4,5,6],
//         "breaks": { "MORNING": { "start": "11:00", "minutes": 15 },
//                     "LUNCH":   { "start": "13:00", "minutes": 30 },
//                     "EVENING": { "start": "16:00", "minutes": 15 } } }
//     ]
//   }
// Optional per shift: "windowBeforeMin" (default 30), "windowAfterMin" (default 60),
// per break "allowSkip" (default true, false for LUNCH), and "rules" with any of
// ringLeadMin, ringDurationMin, ringSound, reasonOnEarly, reasonOnLate,
// reasonMinChars, overrunReason, overrunGraceMin (existing values are kept otherwise).
// A shift whose name matches an existing one (ignoring case) is updated; any other
// is created. A break kind left out of "breaks" is turned off for that shift.
//
// --dry-run validates everything and prints the plan without changing anything.
// The password is read from the environment and never printed.

import { readFile } from 'node:fs/promises';

const KINDS = ['MORNING', 'LUNCH', 'EVENING'];
const RULE_KEYS = [
  'ringLeadMin',
  'ringDurationMin',
  'ringSound',
  'reasonOnEarly',
  'reasonOnLate',
  'reasonMinChars',
  'overrunReason',
  'overrunGraceMin',
];

function args(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--api') out.api = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--org') out.org = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const fail = (msg) => {
  console.error(`\nStopped: ${msg}`);
  process.exit(1);
};

function hm(value, where) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    fail(`${where} must be a time like 09:30 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function int(value, where, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${where} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
  }
  return value;
}

class Api {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.cookie = '';
    /** 4.0: the organisation a Super Admin acts in (X-Org-Id). */
    this.org = '';
  }

  async call(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.org ? { 'x-org-id': this.org } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length) this.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON: reported below */
    }
    return { status: res.status, json };
  }

  async signIn(email, password) {
    const r = await this.call('POST', '/auth/login', { email, password });
    if (r.status !== 200 || !r.json?.success) {
      fail(`sign-in refused (${r.status}): ${r.json?.message ?? 'no message'}`);
    }
    const role = r.json.data?.user?.role;
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') fail('this account is not an Admin or a Super Admin');
    if (!this.cookie) fail('the API did not return a session cookie');
    return r.json.data.user;
  }
}

/** Builds the API's shift body from one configured shift and the shift it updates (if any). */
function payloadFor(cfg, existing, index) {
  const where = `shifts[${index}] (${cfg?.name ?? 'no name'})`;
  if (!cfg || typeof cfg.name !== 'string' || !cfg.name.trim()) fail(`${where}: give the shift a name`);
  const start = hm(cfg.start, `${where}.start`);
  const end = hm(cfg.end, `${where}.end`);
  const workDays = cfg.workDays ?? existing?.workDays ?? [1, 2, 3, 4, 5, 6];
  if (!Array.isArray(workDays) || !workDays.length) fail(`${where}.workDays must list ISO days 1 (Mon) to 7 (Sun)`);
  workDays.forEach((d, i) => int(d, `${where}.workDays[${i}]`, 1, 7));
  const before = int(cfg.windowBeforeMin ?? 30, `${where}.windowBeforeMin`, 0, 240);
  const after = int(cfg.windowAfterMin ?? 60, `${where}.windowAfterMin`, 0, 480);

  const given = cfg.breaks ?? {};
  for (const k of Object.keys(given)) {
    if (!KINDS.includes(k)) fail(`${where}.breaks has an unknown break "${k}" (use MORNING, LUNCH, EVENING)`);
  }
  const breaks = KINDS.map((kind) => {
    const b = given[kind];
    const old = existing?.breaks?.find((x) => x.kind === kind);
    if (!b) {
      return {
        kind,
        enabled: false,
        startTime: old?.startTime ?? start,
        durationMin: old?.durationMin ?? 15,
        windowBeforeMin: old?.windowBeforeMin ?? before,
        windowAfterMin: old?.windowAfterMin ?? after,
        allowSkip: old?.allowSkip ?? kind !== 'LUNCH',
      };
    }
    return {
      kind,
      enabled: true,
      startTime: hm(b.start, `${where}.breaks.${kind}.start`),
      durationMin: int(b.minutes, `${where}.breaks.${kind}.minutes`, 1, 240),
      windowBeforeMin: int(b.windowBeforeMin ?? before, `${where}.breaks.${kind}.windowBeforeMin`, 0, 240),
      windowAfterMin: int(b.windowAfterMin ?? after, `${where}.breaks.${kind}.windowAfterMin`, 0, 480),
      allowSkip: typeof b.allowSkip === 'boolean' ? b.allowSkip : kind !== 'LUNCH',
    };
  });

  const rules = {};
  for (const key of RULE_KEYS) {
    const v = cfg.rules?.[key] ?? existing?.rules?.[key];
    if (v !== undefined) rules[key] = v;
  }
  for (const k of Object.keys(cfg.rules ?? {})) {
    if (!RULE_KEYS.includes(k)) fail(`${where}.rules has an unknown setting "${k}"`);
  }

  return {
    name: cfg.name.trim(),
    start,
    end,
    workDays,
    ...(existing?.companyId ? { companyId: existing.companyId } : {}),
    ...rules,
    breaks,
  };
}

function describe(body) {
  const days = body.workDays.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(' ');
  const br = body.breaks
    .filter((b) => b.enabled)
    .map((b) => `${b.kind.toLowerCase()} ${b.startTime} ${b.durationMin}m${b.allowSkip ? '' : ' (no skip)'}`)
    .join(', ');
  return `${body.start} to ${body.end}, ${days}; ${br || 'no breaks'}`;
}

async function main() {
  const opts = args(process.argv);
  if (opts.help || !opts.api || !opts.file) {
    console.log('Usage: RXV_ADMIN_EMAIL=... RXV_ADMIN_PASSWORD=... node scripts/configure-shifts.mjs --api https://<api-host>/api/v1 --file shifts.json [--org <id>] [--dry-run]');
    process.exit(opts.help ? 0 : 1);
  }
  const email = process.env.RXV_ADMIN_EMAIL;
  const password = process.env.RXV_ADMIN_PASSWORD;
  if (!email || !password) fail('set RXV_ADMIN_EMAIL and RXV_ADMIN_PASSWORD (the Admin, or a Super Admin)');

  let config;
  try {
    config = JSON.parse(await readFile(opts.file, 'utf8'));
  } catch (err) {
    fail(`could not read ${opts.file}: ${err.message}`);
  }
  if (!Array.isArray(config?.shifts) || !config.shifts.length) fail('the file needs a "shifts" list');
  const names = config.shifts.map((s) => String(s?.name ?? '').trim().toLowerCase());
  if (new Set(names).size !== names.length) fail('two shifts in the file have the same name');

  const api = new Api(opts.api);
  const me = await api.signIn(email, password);
  if (me.role === 'SUPER_ADMIN') {
    if (!opts.org) {
      const orgs = await api.call('GET', '/organisations');
      const rows = Array.isArray(orgs.json?.data) ? orgs.json.data : [];
      console.log('Organisations:');
      for (const o of rows) console.log(`  ${o.id}  ${o.name}`);
      fail('a Super Admin must choose one with --org <id>');
    }
    api.org = opts.org;
  } else if (opts.org) {
    fail('--org is for a Super Admin; an Admin always works in their own organisation');
  }
  const where = me.role === 'SUPER_ADMIN' ? `Super Admin, organisation ${api.org}` : 'Admin';
  console.log(`Signed in as ${me.email} (${where}) at ${api.base}${opts.dryRun ? ' · dry run' : ''}`);

  const list = await api.call('GET', '/shifts');
  if (list.status !== 200 || !Array.isArray(list.json?.data)) fail(`could not list shifts (${list.status})`);
  const existing = list.json.data;

  // Validate everything first, so a mistake in the last shift changes nothing.
  const plan = [];
  for (const [i, cfg] of config.shifts.entries()) {
    const match = existing.find((s) => s.name.trim().toLowerCase() === String(cfg?.name ?? '').trim().toLowerCase());
    const body = payloadFor(cfg, match, i);
    const v = await api.call('POST', '/shifts/validate', body);
    if (v.status !== 200 && v.status !== 201) fail(`${body.name}: validation call failed (${v.status}): ${v.json?.message ?? ''}`);
    if (v.json?.data && v.json.data.valid === false) {
      fail(`${body.name}: ${v.json.data.problems.join(' ')}`);
    }
    plan.push({ body, match });
  }
  const defaultName = config.default ? String(config.default).trim().toLowerCase() : null;
  if (defaultName && !plan.some((p) => p.body.name.toLowerCase() === defaultName) &&
      !existing.some((s) => s.name.trim().toLowerCase() === defaultName)) {
    fail(`default shift "${config.default}" is neither in the file nor an existing shift`);
  }

  console.log('\nPlan:');
  for (const p of plan) console.log(`  ${p.match ? 'update' : 'create'}  ${p.body.name}: ${describe(p.body)}`);
  if (defaultName) console.log(`  default shift: ${config.default}`);
  const untouched = existing.filter((s) => !plan.some((p) => p.match?.id === s.id));
  if (untouched.length) console.log(`  not in the file (left as they are): ${untouched.map((s) => s.name).join(', ')}`);
  if (opts.dryRun) {
    console.log('\nDry run: nothing changed.');
    return;
  }

  const ids = new Map();
  for (const p of plan) {
    const r = p.match
      ? await api.call('PUT', `/shifts/${p.match.id}`, p.body)
      : await api.call('POST', '/shifts', p.body);
    if (r.status !== 200 && r.status !== 201) fail(`${p.body.name}: ${r.status} ${r.json?.message ?? ''}`);
    ids.set(p.body.name.toLowerCase(), r.json?.data?.id ?? p.match?.id);
    console.log(`  ${p.match ? 'updated' : 'created'} ${p.body.name}`);
  }
  if (defaultName) {
    const id = ids.get(defaultName) ?? existing.find((s) => s.name.trim().toLowerCase() === defaultName)?.id;
    const r = await api.call('POST', `/shifts/${id}/default`);
    if (r.status !== 200 && r.status !== 201) fail(`could not make ${config.default} the default (${r.status}): ${r.json?.message ?? ''}`);
    console.log(`  default shift is now ${config.default}`);
  }
  console.log('\nDone. Check Shifts in the portal; staff agents pick the new times up within 15 minutes.');
}

main().catch((err) => fail(err?.message ?? String(err)));
