/**
 * Raised the first time an employee's agent enrolls (installs & activates). The
 * notifications module turns this into a one-time notification for whoever
 * oversees them (4.0: the department's managers for Staff, the organisation's
 * Admin for Managers).
 */
export class AgentActivatedEvent {
  static readonly eventName = 'auth.agent-activated';

  constructor(
    /** 3.x reporting line, kept for compatibility; 4.0 routing ignores it. */
    public readonly managerId: string | null,
    /** The employee whose agent just activated. */
    public readonly userId: string,
    public readonly userName: string,
    public readonly occurredAt: Date,
  ) {}
}
