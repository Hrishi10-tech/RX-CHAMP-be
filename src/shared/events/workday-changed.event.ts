/**
 * Something about these people's working days changed. 4.0: outside their own
 * agent (an approval decided or reopened, a replayed offline action), so their
 * agents re-read today and History. 3.4: also Start Day, End Day, a break, lunch
 * or meeting, leave decided, the day closed automatically, so the phone app shows
 * the agent's state within a second. Both reach the person's own devices as
 * `workday:changed` on /notifications.
 */
export class WorkdayChangedEvent {
  static readonly eventName = 'workday.changed';

  constructor(
    public readonly userIds: string[],
    /**
     * 4.0: DECISION | REPLAY | CALENDAR | OTHER. 3.4: DAY, PRESENCE, BREAK, MEETING,
     * LEAVE or AUTO (what changed, for logs and clients).
     */
    public readonly reason: string,
    public readonly at: string = new Date().toISOString(),
  ) {}
}
