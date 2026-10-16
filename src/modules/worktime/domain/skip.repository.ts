import { BreakRecordRow, NewBreakRecord } from '@modules/shifts/domain/break-record.repository';
import { AgentGeneration } from './agent-generation';

export const SKIP_REPOSITORY = Symbol('SKIP_REPOSITORY');

export type SkipRefusal =
  | 'DAY_NOT_STARTED'
  | 'DAY_ENDED'
  | 'BREAK_ALREADY_TAKEN'
  | 'ALREADY_ON_BREAK';

export type CreateSkipResult =
  | { ok: true; record: BreakRecordRow }
  | { ok: false; code: SkipRefusal };

/** Writes skip records (SPEC 1.4). PENDING ones get their 48-hour due time. */
export interface SkipRepository {
  /**
   * A manual skip, in one transaction with the user's row lock: the day must be
   * open (an implicit session for a legacy caller), no record of that break yet,
   * not on a break or lunch. The unique key (user, date, kind, seq) backs it up.
   */
  createSkip(
    record: NewBreakRecord,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<CreateSkipResult>;

  /** Auto-skips; a break that got a record meanwhile is silently left out. */
  createAutoSkips(records: NewBreakRecord[], now: Date): Promise<BreakRecordRow[]>;
}
