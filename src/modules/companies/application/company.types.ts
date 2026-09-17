import { BulkError } from '@shared/types/common.types';
import { PaginatedResult } from '@shared/types/pagination.types';

export interface PublicCompany {
  id: string;
  name: string;
  createdAt: string;
}

export interface PublicCompanyManager {
  id: string;
  email: string;
  name: string;
  joinedOn: string;
  userCount: number;
}

export interface PublicCompanyWithStats extends PublicCompany {
  status: string;
  joinedOn: string;
  managerCount: number;
  userCount: number;
  managers: PublicCompanyManager[];
}

export interface PublicManagerUser {
  id: string;
  name: string;
  role: string;
}

export type ListCompaniesResult = PaginatedResult<'companies', PublicCompanyWithStats>;

export type ListManagerUsersResult = PaginatedResult<'users', PublicManagerUser>;

export interface CreateCompanyInput {
  name: string;
  managerIds?: string[];
}

export interface CompanyAssignmentSummary {
  assigned: string[];
  errors: BulkError<'managerId'>[];
}

export interface UpdateCompanyInput {
  name: string;
}

export interface DeleteCompanyResult {
  deleted: true;
  id: string;
  name: string;
  /** Members soft-deleted alongside the company. */
  membersRemoved: number;
}

export interface CreateCompanyResult extends PublicCompany {
  assignments: CompanyAssignmentSummary;
}
