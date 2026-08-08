/**
 * Raised the first time an employee ends their working day from the agent
 * ("End Day"). Two modules subscribe:
 *
 *  - presence closes the open break/lunch/meeting and the open online session at
 *    `endedAt`, so attendance stops accruing at the same instant activity does;
 *  - notifications turns it into a persisted notification + bell update for the
 *    employee's manager.
 *
 * Fired once per user per local day — pressing End Day again is a no-op.
 */
export class DayEndedEvent {
  static readonly eventName = 'activity.day-ended';

  constructor(
    /** The employee who ended their day. */
    public readonly userId: string,
    public readonly userName: string,
    /** Who to tell, or null when the employee has no manager. */
    public readonly managerId: string | null,
    /** Local calendar day (YYYY-MM-DD) that was ended. */
    public readonly date: string,
    /** The instant everything freezes at. */
    public readonly endedAt: Date,
  ) {}
}
