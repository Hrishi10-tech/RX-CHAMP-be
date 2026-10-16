import { Inject, Injectable } from '@nestjs/common';
import { addDaysToKey, dateKeyInZone } from '@shared/utils/timezone';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
} from '../domain/break-record.repository';
import { SHIFT_REPOSITORY, ShiftRepository } from '../domain/shift.repository';
import { DEFAULT_REASON_MIN_CHARS, ShiftRecord } from '../domain/shift.types';
import { BreakDayService } from './break-day.service';
import { ShiftMapper } from './shift.mapper';
import { SkipNeedingComment } from './shifts.types';

/** How far back a skip still needs a comment (SPEC 1.4: the last 31 days). */
export const COMMENT_LOOKBACK_DAYS = 31;

/**
 * The skips a person still has to comment on: SKIPPED or AUTO_SKIPPED, no
 * reason, still PENDING, dated in the last 31 days. Newest first. A decided one
 * no longer needs a comment; a Super Admin's never do (they need no approval).
 */
@Injectable()
export class SkipsNeedingCommentQuery {
  constructor(
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    private readonly days: BreakDayService,
  ) {}

  async forUser(userId: string, now: Date): Promise<SkipNeedingComment[]> {
    const today = dateKeyInZone(now, this.days.timezone);
    const rows = await this.records.listSkipsNeedingComment(
      userId,
      addDaysToKey(today, -(COMMENT_LOOKBACK_DAYS - 1)),
    );
    if (!rows.length) return [];
    const shifts = new Map((await this.shifts.list()).map((s) => [s.id, s] as const));
    return rows
      .map((r) => ShiftMapper.skipNeedingComment(r, minCharsFor(r, shifts)))
      .filter((x): x is SkipNeedingComment => x !== null);
  }
}

/** The reason length a record's shift asks for (the default when the shift is gone). */
export function minCharsFor(
  r: Pick<BreakRecordRow, 'shiftId'>,
  shifts: Map<string, Pick<ShiftRecord, 'reasonMinChars'>>,
): number {
  return (
    (r.shiftId ? shifts.get(r.shiftId)?.reasonMinChars : undefined) ?? DEFAULT_REASON_MIN_CHARS
  );
}
