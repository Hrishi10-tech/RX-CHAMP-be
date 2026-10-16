import { Routing } from '../domain/break-record.repository';
import { BreakRecordRow } from '../domain/break-record.repository';
import { ShiftPerson } from '../domain/shift-people.reader';
import { BreakApprovalStatus } from '../domain/shift.types';

export interface RouteDecision extends Routing {
  status: BreakApprovalStatus;
}

export interface Approver {
  id: string;
  role: 'SUPER_ADMIN' | 'MANAGER' | 'USER';
}

/**
 * Who approves an off-schedule break, and who may decide one.
 *
 *  - Staff: their own manager (users.manager_id) when that is an active Manager
 *    or Super Admin; otherwise the Super Admin pool.
 *  - Managers: the Super Admin pool, every day.
 *  - Super Admins: nobody above them, so nothing to approve.
 */
export class BreakApprovalPolicy {
  static route(subject: ShiftPerson, manager: ShiftPerson | null): RouteDecision {
    if (subject.role === 'SUPER_ADMIN') {
      return { status: 'NOT_REQUIRED', approverRole: null, approverId: null };
    }
    if (subject.role === 'MANAGER') {
      return { status: 'PENDING', approverRole: 'SUPER_ADMIN', approverId: null };
    }
    if (
      manager &&
      manager.active &&
      (manager.role === 'MANAGER' || manager.role === 'SUPER_ADMIN')
    ) {
      return { status: 'PENDING', approverRole: manager.role, approverId: manager.id };
    }
    return { status: 'PENDING', approverRole: 'SUPER_ADMIN', approverId: null };
  }

  /**
   * A Super Admin may decide anything except their own (escalated items
   * included); a Manager only what is routed to them. Works for any approval
   * item (break or meeting record).
   */
  static canDecide(
    actor: Approver,
    record: Pick<BreakRecordRow, 'userId' | 'approverId'>,
  ): boolean {
    if (record.userId === actor.id) return false;
    if (actor.role === 'SUPER_ADMIN') return true;
    if (actor.role === 'MANAGER') return record.approverId === actor.id;
    return false;
  }

  /** Who may see a record in an approvals list (deciding is checked separately). */
  static canView(
    actor: Approver,
    record: Pick<BreakRecordRow, 'userId' | 'approverId'>,
    subjectManagerId: string | null,
  ): boolean {
    if (actor.role === 'SUPER_ADMIN') return true;
    if (actor.role === 'MANAGER')
      return record.approverId === actor.id || subjectManagerId === actor.id;
    return record.userId === actor.id;
  }
}
