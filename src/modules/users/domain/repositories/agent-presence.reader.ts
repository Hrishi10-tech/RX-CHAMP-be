export const AGENT_PRESENCE_READER = Symbol('AGENT_PRESENCE_READER');

/**
 * When each user's agent was last heard from. Enough to tell "installed and
 * reporting" from "installed and silent", which a one-off activation stamp cannot:
 * `agentActivatedAt` is set on first enrolment and never cleared, so on its own it
 * says nothing about whether anyone is being tracked today.
 *
 * Its own port so the users module doesn't depend on the activity module.
 */
/** Everything the Status column needs about one user's agent, in one shape. */
export interface AgentPresence {
  /** Newest activity report, or undefined if they have never sent one. */
  lastSeenAt?: Date;
  /** They pressed End Day for today, so silence is expected rather than a fault. */
  dayEndedToday: boolean;
  /**
   * They hold no session the agent could use. Covers a deliberate sign-out and a
   * session that broke on its own — indistinguishable from here, and the remedy is
   * the same either way: sign in again.
   */
  signedOut: boolean;
}

export interface AgentPresenceReader {
  /**
   * Agent state for the given users, in as few queries as possible. Users with
   * nothing recorded are absent from the map rather than present with empty values.
   */
  presenceFor(userIds: string[]): Promise<Map<string, AgentPresence>>;
}
