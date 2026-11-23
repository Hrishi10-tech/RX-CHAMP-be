export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function managerRoom(managerId: string): string {
  return `manager:${managerId}`;
}

/** 4.0: an organisation's admins (Admin, and a Super Admin who chose it). */
export function orgRoom(companyId: string): string {
  return `org:${companyId}`;
}

/** 4.0: the managers of a department. */
export function deptRoom(departmentId: string): string {
  return `dept:${departmentId}`;
}

/**
 * Which grant a namespace's live data needs from a Manager: presence any grant,
 * screenshots the screenshots grant, activity the timeline grant (apps, titles,
 * sites) or the activity grant (active and idle time), each pushed redacted to
 * the managers who hold only one of them (activityViewRoom).
 */
export type LiveSection = 'presence' | 'activity' | 'screenshots';

/** A Manager's part of a live activity push: apps and sites only, or active/idle time only. */
export type PartialActivityView = 'timeline' | 'activity';

/**
 * 4.0: the managers of a department who hold only one of the timeline and
 * activity grants get the live activity push redacted to it in this room (with
 * both grants they are in the department's own room, with the whole push).
 */
export function activityViewRoom(departmentRoom: string, view: PartialActivityView): string {
  return `${departmentRoom}|${view}`;
}

export interface RoomSubject {
  companyId: string | null;
  departmentId: string | null;
  role: string;
}

/**
 * Rooms a live update about `s` goes to (docs/4.0/SPEC.md 1.4): the organisation's
 * admins, and the managers of their department when they are Staff. Never across
 * organisations.
 */
export function roomsOfSubject(s: RoomSubject): string[] {
  const rooms: string[] = [];
  if (s.companyId) rooms.push(orgRoom(s.companyId));
  if (s.role === 'USER' && s.departmentId) rooms.push(deptRoom(s.departmentId));
  return rooms;
}

/** 4.0: every signed-in socket of an organisation (agents and portal), for config pushes. */
export function membersRoom(companyId: string): string {
  return `members:${companyId}`;
}

/**
 * 3.6 avatars, on /notifications: the Super Admins and the Super Manager on the
 * "All organisations" view (no organisation picked), who see people of every one.
 */
export const ALL_ORGS_ROOM = 'org:*';

/** 3.6 avatars, on /notifications: every Super Admin and Super Manager socket. */
export const PLATFORM_ROOM = 'platform';

/** 3.6 avatars, on /notifications: the Staff of a department (they see its managers). */
export function deptStaffRoom(departmentId: string): string {
  return `dept-staff:${departmentId}`;
}

export interface AvatarSubject {
  id: string;
  role: string;
  companyId: string | null;
  departmentId: string | null;
  /** The departments a Manager manages (empty for other roles). */
  managedDepartmentIds: string[];
}

/**
 * 4.0: the /notifications rooms an `avatar:changed` about `s` goes to: the people
 * who are shown that person, and nobody across organisations.
 *  - the person's own devices;
 *  - in an organisation: its admins and the Super Admins or Super Manager who have
 *    it in view (orgRoom), or who are on "All organisations" (ALL_ORGS_ROOM);
 *  - Staff: the managers of their department (deptRoom);
 *  - a Manager: the Staff of the departments they manage (deptStaffRoom);
 *  - an Admin: everyone in the organisation (membersRoom), who all have them in Messages;
 *  - no organisation (a Super Admin or the Super Manager): the platform roles.
 */
export function avatarRoomsOf(s: AvatarSubject): string[] {
  const rooms = [userRoom(s.id)];
  if (!s.companyId) {
    rooms.push(PLATFORM_ROOM);
    return rooms;
  }
  rooms.push(orgRoom(s.companyId), ALL_ORGS_ROOM);
  if (s.role === 'USER' && s.departmentId) rooms.push(deptRoom(s.departmentId));
  if (s.role === 'MANAGER') rooms.push(...s.managedDepartmentIds.map(deptStaffRoom));
  if (s.role === 'ADMIN') rooms.push(membersRoom(s.companyId));
  return rooms;
}
