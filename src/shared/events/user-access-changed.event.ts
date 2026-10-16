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
  ) {}
}
