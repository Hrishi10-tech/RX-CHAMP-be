import { ApproverRoute } from './leave-policy';

/**
 * Who decides a leave request (3.4, on 4.0's routing). Pure.
 *
 * 4.0 routes approvals like breaks (docs/4.0/SPEC.md 1.3): Staff in a department
 * with an active Manager go to that department's Managers; Managers, and Staff with
 * nobody to decide in their department, go to the organisation's Admin. An Admin's
 * leave goes to the Super Admins. The policy can send everything to the Super
 * Manager (3.3) or straight to the Admin instead. Nobody decides their own.
 *
 * The policy's route names are 3.4's: 'SUPER_ADMIN' means "the organisation's
 * Admin" in 4.0 (a Super Admin acting in the organisation decides too).
 */

export type DeciderRole = 'MANAGER' | 'ADMIN' | 'SUPER_MANAGER' | 'SUPER_ADMIN';

export interface RoutedPerson {
  id: string;
  role: string;
  companyId: string | null;
  departmentId: string | null;
}

export interface RoutingPeople {
  /** Active Managers of the person's department (empty without one). */
  departmentManagerIds: readonly string[];
  /** Active Admins of the person's organisation. */
  adminIds: readonly string[];
  superManagerIds: readonly string[];
  superAdminIds: readonly string[];
}

export interface Route {
  /** null: nobody is left to ask (a lone Super Admin), so it is approved at once. */
  approverRole: DeciderRole | null;
  /** 4.0 decides by role and department when deciding: never written. */
  approverId: string | null;
  /** Who is told a request is waiting. */
  notify: string[];
}

function pool(role: DeciderRole, ids: readonly string[], person: RoutedPerson): Route | null {
  const others = ids.filter((id) => id !== person.id);
  return others.length ? { approverRole: role, approverId: null, notify: [...others] } : null;
}

const NOBODY: Route = { approverRole: null, approverId: null, notify: [] };

/** Where a new request goes. A route with nobody in it falls to the next one up. */
export function routeFor(route: ApproverRoute, person: RoutedPerson, people: RoutingPeople): Route {
  const superAdmins = () => pool('SUPER_ADMIN', people.superAdminIds, person) ?? NOBODY;
  const admins = () => pool('ADMIN', people.adminIds, person) ?? superAdmins();
  if (person.role === 'SUPER_ADMIN' || person.role === 'SUPER_MANAGER' || person.role === 'ADMIN') {
    return superAdmins();
  }
  if (route === 'SUPER_MANAGER') {
    return pool('SUPER_MANAGER', people.superManagerIds, person) ?? admins();
  }
  if (route === 'MANAGER' && person.role === 'USER' && person.departmentId) {
    return pool('MANAGER', people.departmentManagerIds, person) ?? admins();
  }
  return admins();
}

export interface DecidableRequest {
  userId: string;
  approverRole: DeciderRole | null;
}

/** The caller as the rules need them (the signed-in user). */
export interface Decider {
  id: string;
  role: string;
  /** The departments a Manager oversees. */
  managedDepartmentIds?: readonly string[];
}

/** The person whose request it is, now. */
export interface DecidedFor {
  role: string;
  departmentId: string | null;
}

/**
 * May `me` decide (approve, reject, revoke) this request? The caller must already
 * see the person (same organisation, or one in view). A Manager decides a request
 * on the Manager route for Staff in their departments now (a move of department
 * moves the request with them); the Super Manager what the Manager or Super
 * Manager route holds; the organisation's Admin and a Super Admin anything of its
 * Staff and Managers; a Super Admin also an Admin's.
 */
export function canDecide(me: Decider, req: DecidableRequest, target: DecidedFor): boolean {
  if (me.id === req.userId) return false;
  switch (me.role) {
    case 'SUPER_ADMIN':
      return target.role !== 'SUPER_ADMIN' || req.approverRole === 'SUPER_ADMIN';
    case 'ADMIN':
      return target.role === 'USER' || target.role === 'MANAGER';
    case 'SUPER_MANAGER':
      return (
        (target.role === 'USER' || target.role === 'MANAGER') &&
        (req.approverRole === 'MANAGER' || req.approverRole === 'SUPER_MANAGER')
      );
    case 'MANAGER':
      return (
        req.approverRole === 'MANAGER' &&
        target.role === 'USER' &&
        !!target.departmentId &&
        (me.managedDepartmentIds ?? []).includes(target.departmentId)
      );
    default:
      return false;
  }
}

/**
 * Is the request waiting on `me` in particular (the badge and "Needs you")? The
 * Super Manager and the Admin may stand in for a Manager, but those are not
 * counted as theirs unless the department has nobody to decide.
 */
export function waitsOn(
  me: Decider,
  req: DecidableRequest,
  target: DecidedFor & { departmentHasManager: boolean },
): boolean {
  if (me.id === req.userId) return false;
  switch (req.approverRole) {
    case 'MANAGER':
      if (me.role === 'MANAGER') return canDecide(me, req, target);
      // A department left without a Manager falls to the organisation's Admin.
      return (me.role === 'ADMIN' || me.role === 'SUPER_ADMIN') && !target.departmentHasManager;
    case 'ADMIN':
      return me.role === 'ADMIN' || me.role === 'SUPER_ADMIN';
    case 'SUPER_MANAGER':
      return me.role === 'SUPER_MANAGER';
    case 'SUPER_ADMIN':
      return me.role === 'SUPER_ADMIN';
    default:
      return false;
  }
}
