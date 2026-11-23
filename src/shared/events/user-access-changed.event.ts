/**
 * STATUS   blocked or unblocked (see `active`)
 * ROLE     role changed
 * MANAGER  reports to someone else now
 * DELETED  soft-deleted
 * PASSWORD password set by an administrator
 * SIGN_OUT every session should end (an administrator asked for it)
 */
export type UserAccessChange = 'STATUS' | 'ROLE' | 'MANAGER' | 'DELETED' | 'PASSWORD' | 'SIGN_OUT';

/**
 * Something that decides who approves whom, or whether someone may stay signed
 * in, changed for a user. Break approvals re-route, sessions end and live
 * sockets drop accordingly.
 */
export class UserAccessChangedEvent {
  static readonly eventName = 'user.access-changed';

  constructor(
    public readonly userId: string,
    public readonly changes: UserAccessChange[],
    public readonly at: Date,
    /** The account's state after the change, when known. */
    public readonly active?: boolean,
    /**
     * 4.0, a change of role or departments: where they stood until now, so whoever
     * their approvals waited on, or who waited on them, can be told (3.6 sent the
     * former manager instead; 4.0 routes by department).
     */
    public readonly formerPlacement?: FormerPlacement,
  ) {}
}

/** A person's role and departments before a change (4.0 approval routing reads these). */
export interface FormerPlacement {
  role: string;
  /** The department they belonged to. */
  departmentId: string | null;
  /** The departments they managed (a Manager). */
  managedDepartmentIds: string[];
}

/**
 * Whether credentials minted before this change must stop working: the person's
 * auth epoch is raised and their live sockets drop. A sign-out, a delete, a role
 * or manager change, and a block or an unblock. The unblock counts too: an account
 * blocked before the epoch existed still sits at 0, which is also what a token
 * without the claim reads as, so coming back must move it. A password set by an
 * administrator without "sign out everywhere" does not.
 */
export function endsCredentials(e: UserAccessChangedEvent): boolean {
  return e.changes.some(
    (c) => c === 'SIGN_OUT' || c === 'DELETED' || c === 'STATUS' || c === 'ROLE' || c === 'MANAGER',
  );
}
