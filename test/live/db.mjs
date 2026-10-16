// Direct database access for the live suites that must set up what no API can: a skip
// left from yesterday, an item made overdue, a day in an earlier month, a simulated month.
// Local databases only: the script stops unless DATABASE_URL points at this machine.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** DATABASE_URL from the environment, else from backend/.env (never printed). */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // No .env file: handled below.
  }
  return null;
}

/** DATABASE_URL when it points at this machine, or exit(2) for anything else. */
export function localDatabaseUrl() {
  const url = databaseUrl();
  let host = null;
  try {
    host = url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    host = null;
  }
  if (!host || !LOCAL_HOSTS.has(host)) {
    console.error(
      'Refusing to write to the database: DATABASE_URL must point at a local database (localhost). ' +
        'These suites change data directly.',
    );
    process.exit(2);
  }
  return url;
}

/** A Prisma client on the local database, or exit(2) for anything else. */
export async function openDb() {
  const url = localDatabaseUrl();
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({ datasources: { db: { url } } });
}

// Must match the API's APP_TIMEZONE.
export const TZ = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

/** The instant of a wall-clock time ("HH:MM") on a business day ("YYYY-MM-DD"). */
export function wallToUtc(dateKey, hm) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess));
}
