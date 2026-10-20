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
