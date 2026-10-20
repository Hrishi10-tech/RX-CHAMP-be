import { SearchPageFilter } from '@shared/types/pagination.types';

export const COMPANY_REPOSITORY = Symbol('COMPANY_REPOSITORY');

export interface CompanyRecord {
  id: string;
  name: string;
  createdAt: Date;
}

export interface CompanyManagerStats {
  id: string;
  email: string;
  name: string;
  /** 4.0: active Staff in the manager's departments. */
  userCount: number;
}

export interface CompanyWithStats extends CompanyRecord {
  managerCount: number;
  userCount: number;
  managers: CompanyManagerStats[];
}

export interface ListCompaniesFilter extends SearchPageFilter {
  /** Restrict to these company ids (an Admin or Manager sees only their own). */
  ids?: string[];
}

/**
 * Read side of the 3.x /companies list, kept as an alias of /organisations for one
 * release (docs/4.0/SPEC.md 5.1). Writes go through the organisations module.
 */
export interface CompanyRepository {
  findAllWithStats(filter?: ListCompaniesFilter): Promise<CompanyWithStats[]>;
  count(filter?: ListCompaniesFilter): Promise<number>;
}
