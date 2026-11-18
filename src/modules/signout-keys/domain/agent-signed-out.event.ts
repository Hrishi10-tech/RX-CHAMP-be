/**
 * A person's agent signed out with a key (docs/4.0/SPEC.md 2.8). Their agent
 * sessions are already revoked and their enrollVersion moved on; the portal session
 * is untouched, so this is deliberately not a UserAccessChangedEvent SIGN_OUT
 * (which would end every session and drop the portal's sockets too).
 */
export class AgentSignedOutEvent {
  static readonly eventName = 'agent.signed-out';

  constructor(
    public readonly userId: string,
    public readonly companyId: string,
    /** The key used; null for a 4.1 shared-computer sign-out at the shift end. */
    public readonly keyId: string | null,
    public readonly at: Date,
  ) {}
}
