import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { canSeePerson, isAdminLike, managedDeptIds, orgOf, PersonFacts } from '@shared/tenancy';
import { Routing } from '../domain/break-record.repository';
import { ShiftPerson } from '../domain/shift-people.reader';
import { BreakApprovalStatus } from '../domain/shift.types';

export interface RouteDecision extends Routing {
  status: BreakApprovalStatus;
}

/** The caller deciding (the signed-in user). */
export type Approver = AuthenticatedUser;

/** The subject of an approval item, as far as routing needs it. */
export type ApprovalSubject = Pick<ShiftPerson, 'id' | 'role' | 'companyId' | 'departmentId'>;

/**
 * 4.0 approval routing (docs/4.0/SPEC.md 1.3), for every approval item (break,
 * skip, meeting, away):
 *
 *  - Staff in a department: any Manager assigned to that department at decision
 *    time, the organisation's Admin, or a Super Admin. Stored approverRole MANAGER.
 *  - Staff with no department, and Managers: the Admin (or a Super Admin).
 *    Stored approverRole ADMIN.
 *  - Admins and Super Admins: nothing to approve.
 *
 * approverId is no longer written: who may decide is worked out from the
 * subject's organisation and department when deciding, so moving a person or a
 * manager between departments re-routes everything waiting at once.
 * Nobody decides their own item.
 */
export class BreakApprovalPolicy {
  static route(
    subject: Pick<ShiftPerson, 'role' | 'departmentId'>,
    _unused?: unknown,
  ): RouteDecision {
    if (subject.role === 'SUPER_ADMIN' || subject.role === 'ADMIN') {
      return { status: 'NOT_REQUIRED', approverRole: null, approverId: null };
    }
    if (subject.role === 'USER' && subject.departmentId) {
      return { status: 'PENDING', approverRole: 'MANAGER', approverId: null };
    }
    return { status: 'PENDING', approverRole: 'ADMIN', approverId: null };
  }

  /**
   * Whether `actor` may decide (approve, reject, reopen) an item of `subject`:
   * never their own; Admin and Super Admin anything in the organisation; a Manager
   * Staff in their departments. An unknown subject (deleted) only by an admin of
   * the organisation the record still names, which the caller must have checked.
   */
  static canDecide(
    actor: Approver,
    record: { userId: string },
    subject: ApprovalSubject | null | undefined,
  ): boolean {
    if (record.userId === actor.id) return false;
    if (!subject) return false;
    const facts: PersonFacts = {
      id: subject.id,
      role: subject.role,
      companyId: subject.companyId,
      departmentId: subject.departmentId,
    };
    if (!canSeePerson(actor, facts)) return false;
    if (isAdminLike(actor)) return subject.role === 'USER' || subject.role === 'MANAGER';
    if (actor.role === Role.MANAGER) {
      return (
        subject.role === 'USER' &&
        !!subject.departmentId &&
        managedDeptIds(actor).includes(subject.departmentId)
      );
    }
    return false;
  }

  /** Who may see an item in a list or report (deciding is checked separately). */
  static canView(
    actor: Approver,
    record: { userId: string },
    subject: ApprovalSubject | null | undefined,
  ): boolean {
    if (record.userId === actor.id) return true;
    if (!subject) return false;
    return canSeePerson(actor, {
      id: subject.id,
      role: subject.role,
      companyId: subject.companyId,
      departmentId: subject.departmentId,
    });
  }

  /** The organisation an approver acts in (null: platform view, sees no items). */
  static orgOf(actor: Approver): string | null {
    return orgOf(actor);
  }
}
