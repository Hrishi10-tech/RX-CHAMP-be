/**
 * 4.0: activity samples changed time that is no longer live for this person: an
 * offline backlog uploaded late, a sample stored after the day closed, or the
 * stamped duration of an earlier day's last sample. Hour buckets kept for that
 * person's closed days are stale (worktime DayDataService).
 */
export class ActivityBackfilledEvent {
  static readonly eventName = 'activity.backfilled';

  constructor(public readonly userId: string) {}
}
