import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { InputSample } from '../domain/input-activity';
import { InputSamplesReader, SampleWindow } from '../domain/input-samples.reader';

/** Reads activity_samples for many (person, span) windows at once. */
@Injectable()
export class PrismaInputSamplesReader implements InputSamplesReader {
  constructor(private readonly prisma: PrismaService) {}

  async samplesInWindows(windows: SampleWindow[]): Promise<Map<string, InputSample[]>> {
    const out = new Map<string, InputSample[]>();
    const valid = windows.filter((w) => w.to.getTime() > w.from.getTime());
    for (const w of windows) out.set(w.key, []);
    if (!valid.length) return out;
    // activity_samples.at is timestamp(3) holding UTC, so every bound is turned
    // into a UTC timestamp the same way, independent of the database time zone.
    const rows = await this.prisma.$queryRaw<
      {
        key: string;
        at: Date;
        duration_sec: number;
        idle: boolean;
        locked: boolean;
        app: string | null;
      }[]
    >`
      SELECT w.key, s.at, s.duration_sec, s.idle, s.locked, s.app
        FROM unnest(${valid.map((w) => w.key)}::text[],
                    ${valid.map((w) => w.userId)}::uuid[],
                    ${valid.map((w) => w.from.toISOString())}::text[],
                    ${valid.map((w) => w.to.toISOString())}::text[])
             AS w(key, user_id, from_iso, to_iso)
        JOIN activity_samples s
          ON s.user_id = w.user_id
         AND s.at >= (w.from_iso::timestamptz AT TIME ZONE 'UTC')
         AND s.at <  (w.to_iso::timestamptz AT TIME ZONE 'UTC')
       ORDER BY w.key, s.at`;
    for (const r of rows) {
      out.get(r.key)?.push({
        at: r.at,
        durationSec: Number(r.duration_sec) || 0,
        idle: r.idle,
        locked: r.locked,
        app: r.app,
      });
    }
    return out;
  }
}
