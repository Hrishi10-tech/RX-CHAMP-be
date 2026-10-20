import {
  AssignmentTarget,
  ShiftAssignmentRecord,
  ShiftDefinition,
  ShiftRecord,
} from './shift.types';

export const SHIFT_REPOSITORY = Symbol('SHIFT_REPOSITORY');

export interface ShiftWriteData extends ShiftDefinition {
  companyId: string | null;
}

export interface NewAssignment {
  target: AssignmentTarget;
  companyId: string | null;
  department: string | null;
  departmentKey: string | null;
  userId: string | null;
  shiftId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdById: string | null;
}

export interface ShiftUsage {
  /** Assignment rows in force today or starting later that point at the shift. */
  activeAssignments: number;
}

export interface ShiftRepository {
  /** Every non-deleted shift. */
  list(): Promise<ShiftRecord[]>;
  findById(id: string): Promise<ShiftRecord | null>;
  findByName(companyId: string | null, name: string): Promise<ShiftRecord | null>;
  create(data: ShiftWriteData): Promise<ShiftRecord>;
  /** Replaces the definition, including all three breaks. */
  update(id: string, data: ShiftWriteData): Promise<ShiftRecord>;
  /**
   * Creates the shift unless its organisation (or the shared scope) has one of that
   * name, ignoring case: the check and the insert run under one lock per scope, so
   * two creations of one name cannot both succeed. An organisation's first shift
   * becomes its default.
   */
  createUnique(data: ShiftWriteData): Promise<{ ok: true; shift: ShiftRecord } | { ok: false }>;
  /** Replaces the definition unless another shift of its scope has the name (same lock). */
  updateUnique(
    id: string,
    data: ShiftWriteData,
  ): Promise<{ ok: true; shift: ShiftRecord } | { ok: false }>;
  softDelete(id: string): Promise<void>;
  /** Makes `id` the default for its company scope; clears any other default there. */
  setDefault(id: string): Promise<void>;
  /** Default shifts (company ones and the company-less one). */
  listDefaults(): Promise<ShiftRecord[]>;
  usage(id: string, todayKey: string): Promise<ShiftUsage>;
  companyExists(id: string): Promise<boolean>;

  /**
   * Writes assignments, one transaction. Each new row covers [effectiveFrom,
   * effectiveTo or open]; rows of the same target that would start inside that
   * span are superseded (removed, or trimmed to start the day after it ends).
   * Rows that started earlier are left alone: they are history, and newest-wins
   * resolution already lets the new row take over from its first day.
   */
  applyAssignments(rows: NewAssignment[]): Promise<void>;
  /** USER rows for these people plus every DEPARTMENT row, all dates. */
  listAssignmentsFor(userIds: string[]): Promise<ShiftAssignmentRecord[]>;
  /** Every assignment (department and personal), newest first. */
  listAllAssignments(): Promise<ShiftAssignmentRecord[]>;
  listDepartmentAssignments(): Promise<ShiftAssignmentRecord[]>;
}
