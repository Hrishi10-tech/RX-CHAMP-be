export const SHIFT_PEOPLE_READER = Symbol('SHIFT_PEOPLE_READER');

export type PersonRole = 'SUPER_ADMIN' | 'MANAGER' | 'USER';

export interface ShiftPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: PersonRole;
  department: string | null;
  designation: string | null;
  companyId: string | null;
  managerId: string | null;
  active: boolean;
}

export interface PeopleQuery {
  /** Limit to these people's direct reports (a Manager's scope). */
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
  /** Departments in use, with active head-counts. */
  listDepartments(): Promise<DepartmentCount[]>;
  /** Active Super Admin ids, for routing and notifications. */
  listSuperAdminIds(): Promise<string[]>;
}
