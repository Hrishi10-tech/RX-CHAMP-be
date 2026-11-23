export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface TeamMemberRef {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department: string | null;
  /** The effective avatar (3.6); null while the person has no gender. */
  avatarId?: string | null;
}

export interface TeamMemberWithManager extends TeamMemberRef {
  managerId: string | null;
}

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  department: string | null;
  avatarId: string | null;
}

export function fullName(member: Pick<TeamMemberRef, 'firstName' | 'lastName'>): string {
  return `${member.firstName} ${member.lastName}`.trim();
}
