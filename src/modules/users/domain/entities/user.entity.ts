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
  /** First time this user's agent enrolled. Null = never installed anywhere. */
  agentActivatedAt: Date | null;
  createdAt: Date;
  /** 4.0: the person's department (Staff; a Manager's own, optional). */
  departmentId?: string | null;
  /** 4.0: a Manager's view grants. */
  grantScreenshots?: boolean;
  grantTimeline?: boolean;
  grantActivity?: boolean;
  /** 4.0: input-tracking override (null = follow the department). */
  idleEnabled?: boolean | null;
  idleMinutes?: number | null;
  /** 4.0: bumped by a key sign-out or a credential reset. */
  enrollVersion?: number;
  /** 4.0: the person's department as shown (read side). */
  departmentRef?: DepartmentRef | null;
  /** 4.0: departments a Manager is assigned to (read side; empty for other roles). */
  managedDepartments?: DepartmentRef[];
}

/** A department as people lists show it. */
export interface DepartmentRef {
  id: string;
  name: string;
  icon: string;
}

export interface UserGrants {
  screenshots: boolean;
  timeline: boolean;
  activity: boolean;
}

export class User {
  /** Departments to assign as a Manager on the next save (null: unchanged). */
  private pendingManaged: string[] | null = null;

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
  get agentActivatedAt(): Date | null {
    return this.props.agentActivatedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get departmentId(): string | null {
    return this.props.departmentId ?? null;
  }
  get grants(): { screenshots: boolean; timeline: boolean; activity: boolean } {
    return {
      screenshots: this.props.grantScreenshots ?? false,
      timeline: this.props.grantTimeline ?? false,
      activity: this.props.grantActivity ?? false,
    };
  }
  get idleEnabled(): boolean | null {
    return this.props.idleEnabled ?? null;
  }
  get idleMinutes(): number | null {
    return this.props.idleMinutes ?? null;
  }
  get enrollVersion(): number {
    return this.props.enrollVersion ?? 1;
  }
  get departmentRef(): DepartmentRef | null {
    return this.props.departmentRef ?? null;
  }
  get managedDepartments(): DepartmentRef[] {
    return this.props.managedDepartments ?? [];
  }
  get managedDepartmentIds(): string[] {
    return this.pendingManaged ?? this.managedDepartments.map((d) => d.id);
  }
  /** The manager departments to write on save, or null when they did not change. */
  get managedDepartmentsToSave(): string[] | null {
    return this.pendingManaged;
  }

  /** 4.0: the person's department (Staff: their one; a Manager: their own, optional). */
  assignDepartment(dept: DepartmentRef | null): void {
    this.props.departmentId = dept?.id ?? null;
    this.props.departmentRef = dept;
    // users.department keeps the name for display and 3.x shift matching.
    this.props.department = dept?.name ?? null;
  }

  /** 4.0: the departments a Manager oversees (written on save). */
  setManagedDepartments(depts: DepartmentRef[]): void {
    this.pendingManaged = [...new Set(depts.map((d) => d.id))];
    this.props.managedDepartments = depts;
  }

  /** 4.0: a Manager's view grants (always all false for other roles). */
  setGrants(g: UserGrants): void {
    this.props.grantScreenshots = g.screenshots;
    this.props.grantTimeline = g.timeline;
    this.props.grantActivity = g.activity;
  }

  /** 4.0: the input-tracking override (null = follow the department). */
  setIdle(enabled: boolean | null, minutes: number | null): void {
    this.props.idleEnabled = enabled;
    this.props.idleMinutes = minutes;
  }

  /** Called by the repository once the manager departments are written. */
  markSaved(): void {
    this.pendingManaged = null;
  }

  isSuperAdmin(): boolean {
    return this.props.role === Role.SUPER_ADMIN;
  }
  /** Admin or Super Admin (4.0). */
  isAdmin(): boolean {
    return this.props.role === Role.SUPER_ADMIN || this.props.role === Role.ADMIN;
  }
  isOrgAdmin(): boolean {
    return this.props.role === Role.ADMIN;
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
    if (managerId !== null && managerId === this.props.id.value) {
      throw new InvalidUserState('a user cannot be their own manager');
    }
    this.props.managerId = managerId;
  }

  changeRole(next: Role): void {
    this.props.role = next;
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
