import { NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { Role } from '@shared/rbac/roles.enum';
import { DepartmentRef, UserGrants } from '../domain/entities/user.entity';
import { DepartmentReader } from '../domain/repositories/department-reader.port';

export const NO_GRANTS: UserGrants = Object.freeze({
  screenshots: false,
  timeline: false,
  activity: false,
});

/** What a create or edit asks for (undefined = keep what the person has). */
export interface PlacementInput {
  role: Role | string;
  departmentId?: string | null;
  departmentIds?: string[];
  grants?: Partial<UserGrants>;
}

/** Where the person is now (edits only). */
export interface CurrentPlacement {
  role: Role;
  departmentId: string | null;
  managedDepartmentIds: string[];
  grants: UserGrants;
}

/** A checked placement: a Staff member in one department, or a Manager over one or more. */
export interface Placement {
  role: Role.MANAGER | Role.USER;
  /** Staff: their department. Manager: their own (optional; defaults to the first they manage). */
  department: DepartmentRef | null;
  /** Manager: the departments they oversee. Staff: none. */
  managed: DepartmentRef[];
  /** Manager: view grants. Staff: all false. */
  grants: UserGrants;
}

function departmentMissing(): NotFoundError {
  return new NotFoundError(
    'That department does not exist in this organisation.',
    'DEPARTMENT_NOT_FOUND',
  );
}

/**
 * Applies docs/4.0/SPEC.md 2.1 to a create or edit: Staff need exactly one
 * department; Managers one or more (`departmentIds`); every department must belong
 * to the caller's organisation (404 otherwise); grants are for Managers only.
 * One database read for all the departments involved.
 */
export async function resolvePlacement(
  reader: DepartmentReader,
  companyId: string,
  input: PlacementInput,
  current?: CurrentPlacement,
): Promise<Placement> {
  const role = input.role;
  if (role !== Role.MANAGER && role !== Role.USER) {
    throw new ValidationError(
      "Choose Manager or Staff. An organisation's Admin is created from Organisations.",
      'ROLE_NOT_ALLOWED',
    ).withDetails({ field: 'role' });
  }

  const asked = [
    ...(typeof input.departmentId === 'string' ? [input.departmentId] : []),
    ...(input.departmentIds ?? []),
  ];
  const kept = current
    ? [...(current.departmentId ? [current.departmentId] : []), ...current.managedDepartmentIds]
    : [];
  const found = new Map(
    (await reader.findInOrg(companyId, [...asked, ...kept])).map((d) => [d.id, d] as const),
  );
  for (const id of asked) if (!found.has(id)) throw departmentMissing();

  if (role === Role.USER) {
    if (input.departmentIds && input.departmentIds.length > 0) {
      throw new ValidationError(
        'Staff belong to one department. Use departmentId.',
        'STAFF_ONE_DEPARTMENT',
      ).withDetails({ field: 'departmentIds' });
    }
    if (input.grants && Object.values(input.grants).some((g) => g === true)) {
      throw new ValidationError(
        'Grants apply to managers only.',
        'GRANTS_MANAGERS_ONLY',
      ).withDetails({
        field: 'grants',
      });
    }
    const id =
      input.departmentId !== undefined ? input.departmentId : (current?.departmentId ?? null);
    const department = id ? (found.get(id) ?? null) : null;
    if (!department) {
      throw new ValidationError(
        'Choose a department for this staff member.',
        'DEPARTMENT_REQUIRED',
      ).withDetails({
        field: 'departmentId',
      });
    }
    return { role: Role.USER, department, managed: [], grants: { ...NO_GRANTS } };
  }

  // Manager.
  let managedIds: string[];
  if (input.departmentIds !== undefined) managedIds = input.departmentIds;
  else if (current?.role === Role.MANAGER) managedIds = current.managedDepartmentIds;
  else managedIds = current?.departmentId ? [current.departmentId] : [];
  const managed = [...new Set(managedIds)]
    .map((id) => found.get(id))
    .filter((d): d is DepartmentRef => !!d);
  if (managed.length === 0) {
    throw new ValidationError(
      'Choose at least one department for this manager.',
      'DEPARTMENTS_REQUIRED',
    ).withDetails({ field: 'departmentIds' });
  }

  let department: DepartmentRef | null;
  if (input.departmentId !== undefined) {
    department = input.departmentId ? found.get(input.departmentId)! : null;
  } else {
    department = (current?.departmentId && found.get(current.departmentId)) || managed[0];
  }

  const base = current?.role === Role.MANAGER ? current.grants : NO_GRANTS;
  const grants: UserGrants = {
    screenshots: input.grants?.screenshots ?? base.screenshots,
    timeline: input.grants?.timeline ?? base.timeline,
    activity: input.grants?.activity ?? base.activity,
  };
  return { role: Role.MANAGER, department, managed, grants };
}

export function sameGrants(a: UserGrants, b: UserGrants): boolean {
  return a.screenshots === b.screenshots && a.timeline === b.timeline && a.activity === b.activity;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
}
