import { Role } from '@shared/rbac/roles.enum';
import { InvalidUserState } from '@shared/exceptions/domain.exception';
import { UserStatus } from '@shared/types/user.types';
import { Email } from '../value-objects/email.vo';
import { UserId } from '../value-objects/user-id.vo';

export type { UserStatus };

export interface UserProps {
  id: UserId;
  email: Email;
  passwordHash: string;
  firstName: string;
  lastName: string;
  designation: string | null;
  role: Role;
  department: string | null;
  managerId: string | null;
  companyId: string | null;
  companyName: string | null;
  shiftId: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  status: UserStatus;
  screenshotsEnabled: boolean;
  createdAt: Date;
}

export class User {
  private constructor(private props: UserProps) {}
  static fromPersistence(props: UserProps): User {
    return new User(props);
  }
  get id(): string {
    return this.props.id.value;
  }
  get email(): string {
    return this.props.email.value;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get firstName(): string {
    return this.props.firstName;
  }
  get lastName(): string {
    return this.props.lastName;
  }
  get name(): string {
    return `${this.props.firstName} ${this.props.lastName}`.trim();
  }
  get designation(): string | null {
    return this.props.designation;
  }
  get role(): Role {
    return this.props.role;
  }
  get department(): string | null {
    return this.props.department;
  }
  get managerId(): string | null {
    return this.props.managerId;
  }
  get companyId(): string | null {
    return this.props.companyId;
  }
  get companyName(): string | null {
    return this.props.companyName;
  }
  get shiftId(): string | null {
    return this.props.shiftId;
  }
  get shiftStart(): string | null {
    return this.props.shiftStart;
  }
  get shiftEnd(): string | null {
    return this.props.shiftEnd;
  }
  get status(): UserStatus {
    return this.props.status;
  }
  get screenshotsEnabled(): boolean {
    return this.props.screenshotsEnabled;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  isSuperAdmin(): boolean {
    return this.props.role === Role.SUPER_ADMIN;
  }
  isAdmin(): boolean {
    return this.props.role === Role.SUPER_ADMIN || this.props.role === Role.ADMIN;
  }
  isManager(): boolean {
    return this.props.role === Role.MANAGER;
  }
  isPlainUser(): boolean {
    return this.props.role === Role.USER;
  }
  isActive(): boolean {
    return this.props.status === 'ACTIVE';
  }

  /**
   * Turns this user's automatic screenshots on or off. Only the periodic capture is
   * affected — activity tracking and a manager's manual capture are untouched.
   */
  setScreenshotsEnabled(enabled: boolean): void {
    this.props.screenshotsEnabled = enabled;
  }

  changeStatus(next: UserStatus): void {
    if (next !== 'ACTIVE' && next !== 'DISABLED') {
      throw new InvalidUserState('status must be ACTIVE or DISABLED');
    }
    this.props.status = next;
  }

  rename(firstName: string, lastName: string): void {
    const f = firstName.trim();
    const l = lastName.trim();
    if (!f) throw new InvalidUserState('first name is required');
    this.props.firstName = f;
    this.props.lastName = l;
  }

  setDesignation(designation: string | null): void {
    this.props.designation = designation?.trim() || null;
  }

  setDepartment(department: string | null): void {
    this.props.department = department?.trim() || null;
  }

  /**
   * Changes the sign-in identity. The value object validates + lowercases it;
   * uniqueness is the repository's job. Returns false when the address is
   * unchanged, so callers can skip a needless conflict check.
   */
  changeEmail(raw: string): boolean {
    const next = Email.create(raw);
    if (this.props.email.equals(next)) return false;
    this.props.email = next;
    return true;
  }

  assignManager(managerId: string | null): void {
    this.props.managerId = managerId;
  }

  assignCompany(companyId: string | null, companyName: string | null = null): void {
    this.props.companyId = companyId;
    this.props.companyName = companyName;
  }

  setPasswordHash(hash: string): void {
    this.props.passwordHash = hash;
  }

  reactivateWith(firstName: string, lastName: string, designation: string | null): void {
    this.props.status = 'ACTIVE';
    this.rename(firstName, lastName);
    if (designation) this.setDesignation(designation);
  }
}
