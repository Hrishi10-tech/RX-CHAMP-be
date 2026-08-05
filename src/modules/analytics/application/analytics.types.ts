import { DayValue, HourBucket, UsageEntry } from '@shared/types/common.types';

/**
 * The dashboard analytics contract returned by `GET /analytics/:userId`.
 *
 * PHASE 1: every field below is computed from data that already exists
 * (`activity_samples`, `online_sessions`, `presence_sessions`). Fields that need
 * new infrastructure — tasks, categories, deep/shallow, achievements, goals — are
 * present but returned as empty/zero **stubs** so the frontend can integrate now;
 * they get filled in later phases.
 */

export type { DayValue, UsageEntry };

/** One hour of today's timeline. */
export type TimelineBucket = HourBucket;

/** A headline metric: today's value, its change vs the previous day, and a 7-day spark. */
export interface Kpi {
  /** Today's value (seconds, count, or score depending on the metric). */
  value: number;
  /** Percent change vs the previous day; `null` when there's no baseline (prev = 0). */
  deltaPct: number | null;
  /** Last 7 days (oldest first) of this metric — for the sparkline. */
  spark: number[];
}

/** One cell of the 7-day × 24-hour activity heatmap. */
export interface HeatCell extends HourBucket {
  date: string; // YYYY-MM-DD
}

/** A continuous focus stretch (≥ 25 min of uninterrupted active work). */
export interface FocusSession {
  start: string; // ISO
  end: string; // ISO
  durationSec: number;
}

/** Everything a day's dashboard needs, precomputed per day for the 7-day window. */
export interface DayRollup {
  date: string;
  activeSec: number;
  idleSec: number;
  breakSec: number;
  lunchSec: number;
  meetingSec: number;
  focusSec: number;
  score: number;
  hourly: HourBucket[];
}

export interface DashboardKpis {
  active: Kpi; // active (non-idle) work seconds
  idle: Kpi;
  break: Kpi;
  lunch: Kpi;
  meeting: Kpi;
}

export interface DashboardAnalytics {
  userId: string;
  date: string; // the day this dashboard is for
  generatedAt: string; // ISO — when it was computed

  // The five realtime signals (same as the live activity/presence pushes),
  // each with today's value, day-over-day delta, and a 7-day spark.
  kpis: DashboardKpis;

  workVsBreak: { workSec: number; breakSec: number };
  topApps: UsageEntry[];
  timeline: TimelineBucket[]; // today, hourly
  weeklyScore: DayValue[]; // 7 days of score
  focusTrend: DayValue[]; // 7 days of focus seconds
  dailyFlow: HeatCell[]; // 7 days × 24 hours
  focusSessions: FocusSession[]; // today

  // ---- Phase 2–4 stubs (empty until built) --------------------------------
  distribution: { deepSec: number; shallowSec: number }; // Phase 2
  categories: UsageEntry[]; // Phase 2
  taskCompletion: DayValue[]; // Phase 3
  achievements: unknown[]; // Phase 4
  goals: unknown[]; // Phase 4
}
