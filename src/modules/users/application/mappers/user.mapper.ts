import { LIVE_GRACE_SEC } from '@modules/activity/application/activity.constants';
import { elapsedSeconds } from '@modules/activity/application/activity-date.util';
import { User } from '../../domain/entities/user.entity';
import { AgentPresence } from '../../domain/repositories/agent-presence.reader';
import { AgentStatus, PublicUser, UserListItem } from '../user.types';

export class UserMapper {
  static toPublic(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      role: user.role,
      department: user.department,
      designation: user.designation,
      managerId: user.managerId,
      companyId: user.companyId,
      shiftId: user.shiftId,
      shiftStart: user.shiftStart,
      shiftEnd: user.shiftEnd,
      status: user.status,
      screenshotsEnabled: user.screenshotsEnabled,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * The agent's state for one user. The order of these checks is what makes the
   * column worth reading:
   *
   *  - never enrolled outranks everything: no agent, nothing to say about it;
   *  - a live report outranks the rest, including End Day — if something is still
   *    arriving, the agent is plainly running, whatever was pressed earlier;
   *  - End Day outranks being signed out or quiet, because the silence is explained
   *    and needs no attention;
   *  - no usable session comes before plain OFFLINE, since "they must sign in" is a
   *    different job from "go and look at the machine".
   *
   * That leaves OFFLINE meaning only one thing: should be recording, isn't.
   */
  static agentStatusOf(user: User, presence: AgentPresence | undefined, now: Date): AgentStatus {
    if (!user.agentActivatedAt) return 'NOT_ACTIVATED';

    const lastSeen = presence?.lastSeenAt;
    if (lastSeen && elapsedSeconds(lastSeen, now) <= LIVE_GRACE_SEC) return 'LIVE';

    if (presence?.dayEndedToday) return 'DAY_ENDED';
    if (presence?.signedOut) return 'NOT_SIGNED_IN';
    return 'OFFLINE';
  }

  static toListItem(user: User, presence?: AgentPresence, now: Date = new Date()): UserListItem {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      role: user.role,
      department: user.department,
      company: user.companyName,
      status: user.status,
      screenshotsEnabled: user.screenshotsEnabled,
      agentStatus: this.agentStatusOf(user, presence, now),
      agentLastSeenAt: presence?.lastSeenAt ? presence.lastSeenAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
