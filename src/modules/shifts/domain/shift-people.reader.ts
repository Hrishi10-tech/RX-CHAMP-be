export const SHIFT_PEOPLE_READER = Symbol('SHIFT_PEOPLE_READER');

export type PersonRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'USER';

export interface ShiftPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: PersonRole;
  department: string | null;
  designation: string | null;
  companyId: string | null;
  /** 4.0: the person's department. */
  departmentId: string | null;
  /** 3.x reporting line; 4.0 no longer reads it for access or routing. */
  managerId: string | null;
  active: boolean;
}

export interface PeopleQuery {
  /** 4.0: only this organisation's people. */
  companyId?: string;
  /** 4.0: only people in these departments. */
  departmentIds?: string[];
  /** 4.0: only these roles. */
  roles?: PersonRole[];
  /** Limit to these people's direct reports (3.x; unused for access since 4.0). */
  managerId?: string;
  search?: string;
  department?: string;
  ids?: string[];
  skip?: number;
  take?: number;
}

export interface DepartmentCount {
  department: string;
  departmentKey: string;
  companyId: string | null;
  people: number;
}

export interface ShiftPeopleReader {
  findById(id: string): Promise<ShiftPerson | null>;
  findMany(query: PeopleQuery): Promise<ShiftPerson[]>;
  count(query: PeopleQuery): Promise<number>;
  /** These people whatever their status (deactivated or deleted too), for names in history. */
  findAnyByIds(ids: string[]): Promise<ShiftPerson[]>;
  /** Every active person (id, company, department) for resolution and counts. */
  listAllActive(): Promise<ShiftPerson[]>;
  /** Departments in use, with active head-counts (one organisation, or all). */
  listDepartments(companyId?: string): Promise<DepartmentCount[]>;
  /** Active Super Admin ids. */
  listSuperAdminIds(): Promise<string[]>;
  /** 4.0: active Admin ids of an organisation (approvals, escalations, digests). */
  listOrgAdminIds(companyId: string): Promise<string[]>;
  /** 4.0: active Manager ids assigned to a department. */
  listDepartmentManagerIds(departmentId: string): Promise<string[]>;
}
