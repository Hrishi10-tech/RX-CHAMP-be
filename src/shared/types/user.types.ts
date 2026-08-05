export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface TeamMemberRef {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department: string | null;
}

export interface TeamMemberWithManager extends TeamMemberRef {
  managerId: string | null;
}

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  department: string | null;
}

export function fullName(member: Pick<TeamMemberRef, 'firstName' | 'lastName'>): string {
  return `${member.firstName} ${member.lastName}`.trim();
}
