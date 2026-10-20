/**
 * 4.0: something about these people's working days changed outside their own
 * agent (an approval decided or reopened, a replayed offline action). Their
 * agents re-read today and History (`workday:changed` on /notifications).
 */
export class WorkdayChangedEvent {
  static readonly eventName = 'workday.changed';

  constructor(
    public readonly userIds: string[],
    /** DECISION | REPLAY | CALENDAR | OTHER */
    public readonly reason: string,
  ) {}
}
