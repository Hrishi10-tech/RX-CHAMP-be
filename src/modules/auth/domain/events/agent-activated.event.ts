/**
 * Raised the first time an employee's agent enrolls (installs & activates). The
 * notifications module subscribes to turn this into a one-time persisted
 * notification + realtime bell update for the employee's manager.
 */
export class AgentActivatedEvent {
  static readonly eventName = 'auth.agent-activated';

  constructor(
    /** The manager who should be told their report is now set up. */
    public readonly managerId: string,
    /** The employee whose agent just activated. */
    public readonly userId: string,
    public readonly userName: string,
    public readonly occurredAt: Date,
  ) {}
}
