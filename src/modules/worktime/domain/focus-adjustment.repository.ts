import type { FocusAdjustmentRecord } from './focus-adjustment';

export const FOCUS_ADJUSTMENT_REPOSITORY = Symbol('FOCUS_ADJUSTMENT_REPOSITORY');

export interface NewFocusAdjustment {
  userId: string;
  date: string;
  deltaSec: number;
  reason: string;
  createdById: string;
}

export interface AdjustmentListFilter {
  userId?: string;
  userIds?: string[];
  /** "YYYY-MM": adjustments dated in this month. */
  month?: string;
  /** People of this organisation (4.0: the organisation in view). */
  companyId?: string;
  /** Voided ones too (default: live only). */
  includeVoided?: boolean;
  limit?: number;
}

/** A name for the lists: whoever the person was, deleted accounts included. */
export interface AdjustmentPersonName {
  id: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
}

export interface FocusAdjustmentRepository {
  /** Adjustments (live and voided) of these people dated in [fromDate, toDate], for focus time. */
  listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<FocusAdjustmentRecord[]>;
  /** Newest first. */
  list(filter: AdjustmentListFilter): Promise<FocusAdjustmentRecord[]>;
  findById(id: string): Promise<FocusAdjustmentRecord | null>;
  /**
   * Writes one, inside the person's organisation-month lock (409 MONTH_LOCKED when
   * that organisation locked the month).
   */
  create(data: NewFocusAdjustment, now: Date): Promise<FocusAdjustmentRecord>;
  /** Marks one void, inside the month lock. Null when it was already void. */
  void(id: string, byId: string, now: Date): Promise<FocusAdjustmentRecord | null>;
  /** Names and organisations of these people, whatever their status. */
  namesOf(ids: string[]): Promise<AdjustmentPersonName[]>;
}
