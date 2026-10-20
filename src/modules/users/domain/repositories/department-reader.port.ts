import { DepartmentRef } from '../entities/user.entity';

export const DEPARTMENT_READER = Symbol('DEPARTMENT_READER');

/** The departments people may be put in (docs/4.0/SPEC.md 2.1). */
export interface DepartmentReader {
  /** The departments (not deleted) of this organisation among `ids`; others are left out. */
  findInOrg(companyId: string, ids: string[]): Promise<DepartmentRef[]>;
}
