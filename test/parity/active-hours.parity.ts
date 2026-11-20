/**
 * Parity check (Fix 10): the SQL hour buckets (PrismaWorktimeReader.activeSecByHour)
 * must give the same active seconds as the TypeScript rules (input-activity.ts) on
 * the same samples. Writes random days for throwaway users into a LOCAL database,
 * compares, and removes them again.
 *
 *   npx ts-node -r tsconfig-paths/register test/parity/active-hours.parity.ts
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { inputIntervals, InputSample } from '../../src/modules/worktime/domain/input-activity';
import { intersect, Interval, normalize } from '../../src/modules/worktime/domain/intervals';
import { dayHourWindows } from '../../src/modules/worktime/domain/hourly';
import { PrismaWorktimeReader } from '../../src/modules/worktime/infrastructure/prisma-worktime.reader';

const TZ = 'Asia/Kolkata';
const url = process.env.DATABASE_URL ?? 'postgresql://rxv:rxv@localhost:5432/rxv?schema=public';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Local databases only.');
  process.exit(2);
}

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const reader = new PrismaWorktimeReader(prisma as never);
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'USER' } });
  let worst = 0;
  let cases = 0;
  const users: string[] = [];
  try {
    const only = process.env.SEED ? Number(process.env.SEED) : null;
    for (let seed = 1; seed <= 40; seed++) {
      if (only !== null && seed !== only) continue;
      const r = rng(seed);
      const userId = randomUUID();
      users.push(userId);
      await prisma.user.create({
        data: {
          id: userId,
          email: `parity-${seed}-${userId.slice(0, 6)}@x.test`,
          passwordHash: 'x',
          firstName: 'Parity',
          lastName: String(seed),
          roleId: role.id,
        },
      });
      const devices = [randomUUID(), randomUUID()];
      const date = '2026-10-14';
      // 10:00 IST = 04:30 UTC; a session of 6 to 9 hours, sometimes two, sometimes open.
      const t0 = Date.UTC(2026, 9, 14, 4, 30) + Math.floor(r() * 3600) * 1000;
      const sessions: { startedAt: Date; endedAt: Date | null }[] = [];
      const len = (6 + r() * 3) * 3600_000;
      if (r() < 0.3) {
        const mid = t0 + len / 2;
        sessions.push({ startedAt: new Date(t0), endedAt: new Date(mid - 600_000) });
        sessions.push({ startedAt: new Date(mid), endedAt: r() < 0.3 ? null : new Date(t0 + len) });
      } else {
        sessions.push({ startedAt: new Date(t0), endedAt: r() < 0.2 ? null : new Date(t0 + len) });
      }
      for (const s of sessions) {
        await prisma.workSession.create({
          data: { userId, date, startedAt: s.startedAt, endedAt: s.endedAt, source: 'AGENT' },
        });
      }
      const now = new Date(t0 + len + 1800_000);
      // Samples: about one a minute on device 0 (and sometimes device 1), with idle
      // stretches, locks and gaps.
      const samples: InputSample[] = [];
      for (const [di, dev] of devices.entries()) {
        if (di === 1 && r() < 0.6) continue;
        let t = t0 - 120_000 + Math.floor(r() * 60) * 1000;
        let state: 'ACTIVE' | 'IDLE' | 'LOCKED' = 'ACTIVE';
        while (t < now.getTime() - 60_000) {
          const p = r();
          if (state === 'ACTIVE' && p < 0.05) state = 'IDLE';
          else if (state === 'ACTIVE' && p < 0.07) state = 'LOCKED';
          else if (state !== 'ACTIVE' && p < 0.2) state = 'ACTIVE';
          const gap =
            r() < 0.03
              ? 600_000 + Math.floor(r() * 1200) * 1000
              : 50_000 + Math.floor(r() * 20) * 1000;
          samples.push({
            at: new Date(t),
            durationSec: 0,
            idle: state !== 'ACTIVE',
            locked: state === 'LOCKED' && r() < 0.7,
            app: state === 'LOCKED' ? 'LockApp.exe' : 'Code.exe',
            deviceId: dev,
          });
          t += gap;
        }
      }
      // Stamp durations like the writer: the gap to the device's next sample, capped.
      for (const dev of devices) {
        const mine = samples
          .filter((s) => s.deviceId === dev)
          .sort((a, b) => a.at.getTime() - b.at.getTime());
        for (let i = 0; i < mine.length - 1; i++) {
          mine[i].durationSec = Math.min(
            150,
            Math.round((mine[i + 1].at.getTime() - mine[i].at.getTime()) / 1000),
          );
        }
      }
      // The very newest stays open (0); others that ended a device's run keep 0 too
      // only if newest overall; give them a stamped 60 s otherwise.
      const newest = Math.max(...samples.map((s) => s.at.getTime()));
      for (const s of samples)
        if (s.durationSec === 0 && s.at.getTime() !== newest) s.durationSec = 60;
      await prisma.activitySample.createMany({
        data: samples.map((s) => ({
          userId,
          deviceId: s.deviceId ?? null,
          date,
          at: s.at,
          durationSec: s.durationSec,
          idle: s.idle,
          locked: s.locked,
          app: s.app,
        })),
      });

      // TypeScript reference.
      const work: Interval[] = normalize(
        sessions.map((s) => ({ start: s.startedAt.getTime(), end: (s.endedAt ?? now).getTime() })),
      );
      const intervals = inputIntervals(samples, now);
      const hours = dayHourWindows(date, TZ, work);
      const ts = hours.map(
        (h) =>
          intersect(intervals.active, intersect(work, [h])).reduce(
            (a, i) => a + (i.end - i.start),
            0,
          ) / 1000,
      );

      const rows = await reader.activeSecByHour([{ userId, date }], TZ, now);
      const sql = Array<number>(24).fill(0);
      for (const row of rows) sql[row.hour] += row.activeSec;
      if (process.env.KEEP) {
        console.log('kept user', userId, 'now', now.toISOString());
        console.log(
          'ts active',
          JSON.stringify(
            intervals.active.map((i) => [
              new Date(i.start).toISOString().slice(11, 19),
              new Date(i.end).toISOString().slice(11, 19),
            ]),
          ),
        );
        users.pop();
      }
      for (let h = 0; h < 24; h++) {
        const diff = Math.abs(sql[h] - ts[h]);
        worst = Math.max(worst, diff);
        if (diff > 1) console.log(`seed ${seed} hour ${h}: sql ${sql[h]} ts ${ts[h].toFixed(1)}`);
      }
      cases++;
    }
  } finally {
    await prisma.activitySample.deleteMany({ where: { userId: { in: users } } });
    await prisma.workSession.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  }
  console.log(`${cases} random days compared; worst hour difference ${worst.toFixed(2)} s`);
  process.exitCode = worst > 1 ? 1 : 0;
}

void main();
