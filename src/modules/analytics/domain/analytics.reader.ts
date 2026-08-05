import { ManagerLookupReader } from '@shared/rbac/manager-lookup.reader';
import { ActivitySampleRecord } from '@modules/activity/domain/activity-sample.repository';
import { PresenceKind } from '@modules/presence/domain/presence-session.repository';

export const ANALYTICS_READER = Symbol('ANALYTICS_READER');

/** An online (working) session row, as needed for focus/score maths. */
export interface OnlineRow {
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
}

/** A break/lunch/meeting session row. */
export interface PresenceRow {
  type: PresenceKind;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
}

/** All the raw material for the dashboard window, grouped by local date. */
export interface AnalyticsWindow {
  samplesByDate: Map<string, ActivitySampleRecord[]>;
  onlineByDate: Map<string, OnlineRow[]>;
  presenceByDate: Map<string, PresenceRow[]>;
}

/**
 * Read side for the analytics dashboard — pulls activity samples, online sessions
 * and presence sessions for a set of days in a few batched queries.
 */
export interface AnalyticsReader extends ManagerLookupReader {
  /** Load every source for `userId` across the given local dates. */
  loadWindow(userId: string, dates: string[]): Promise<AnalyticsWindow>;
}
