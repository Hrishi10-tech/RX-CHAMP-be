import { ShiftAssignmentRecord, ShiftRecord, ShiftSource, departmentKey } from './shift.types';

export interface PersonForShift {
  id: string;
  companyId: string | null;
  department: string | null;
}

export interface ResolvedShift {
  shift: ShiftRecord | null;
  source: ShiftSource;
  /** The assignment row that decided it (null for DEFAULT / NONE). */
  assignment: ShiftAssignmentRecord | null;
}

function inForce(a: ShiftAssignmentRecord, dateKey: string): boolean {
  return a.effectiveFrom <= dateKey && (!a.effectiveTo || a.effectiveTo >= dateKey);
}

/** Newest first: later effectiveFrom wins, then the most recently created. */
function newest(a: ShiftAssignmentRecord, b: ShiftAssignmentRecord): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * Picks the shift that applies to `person` on `dateKey`.
 *
 *   1. The newest USER assignment in force that day. A row with no shift means
 *      "back to the department's shift" and falls through.
 *   2. The newest DEPARTMENT assignment in force for their department, preferring
 *      a row for their company over a row that applies to every company. A row
 *      with no shift means "no department shift" and falls through.
 *   3. The default shift: their company's, else a company-less default.
 *
 * Deleted shifts are simply absent from `shiftsById`, so an assignment pointing
 * at one falls through to the next level instead of breaking anyone's day.
 */
export function resolveShift(
  person: PersonForShift,
  dateKey: string,
  assignments: ShiftAssignmentRecord[],
  shiftsById: Map<string, ShiftRecord>,
  defaults: ShiftRecord[],
): ResolvedShift {
  const userRows = assignments
    .filter((a) => a.target === 'USER' && a.userId === person.id && inForce(a, dateKey))
    .sort(newest);
  const top = userRows[0];
  if (top?.shiftId) {
    const shift = shiftsById.get(top.shiftId);
    if (shift) return { shift, source: 'OVERRIDE', assignment: top };
  }

  const key = departmentKey(person.department);
  if (key) {
    const deptRows = assignments
      .filter(
        (a) =>
          a.target === 'DEPARTMENT' &&
          a.departmentKey === key &&
          (a.companyId === null || a.companyId === person.companyId) &&
          inForce(a, dateKey),
      )
      .sort((a, b) => {
        // A company-specific row beats a company-less one regardless of date.
        const sa = a.companyId === null ? 1 : 0;
        const sb = b.companyId === null ? 1 : 0;
        return sa !== sb ? sa - sb : newest(a, b);
      });
    const dept = deptRows[0];
    if (dept?.shiftId) {
      const shift = shiftsById.get(dept.shiftId);
      if (shift) return { shift, source: 'DEPARTMENT', assignment: dept };
    }
  }

  const companyDefault =
    defaults.find((s) => s.isDefault && s.companyId !== null && s.companyId === person.companyId) ??
    defaults.find((s) => s.isDefault && s.companyId === null);
  if (companyDefault) return { shift: companyDefault, source: 'DEFAULT', assignment: null };

  return { shift: null, source: 'NONE', assignment: null };
}
