import { PageFilter, SearchPageFilter } from '@shared/types/pagination.types';

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
  userCount: number;
}

export interface CompanyWithStats extends CompanyRecord {
  managerCount: number;
  userCount: number;
  managers: CompanyManagerStats[];
}

export interface ManagerUserRecord {
  id: string;
  name: string;
  role: string;
}

export interface CreateCompanyData {
  name: string;
}

export type ListCompaniesFilter = SearchPageFilter;

export interface CompanyRepository {
  findById(id: string): Promise<CompanyRecord | null>;
  findByName(name: string): Promise<CompanyRecord | null>;
  findAll(filter?: ListCompaniesFilter): Promise<CompanyRecord[]>;
  findAllWithStats(filter?: ListCompaniesFilter): Promise<CompanyWithStats[]>;
  count(filter?: ListCompaniesFilter): Promise<number>;
  create(data: CreateCompanyData): Promise<CompanyRecord>;
  findManagerUsers(
    companyId: string,
    managerId: string,
    page?: PageFilter,
  ): Promise<ManagerUserRecord[]>;
  countManagerUsers(companyId: string, managerId: string): Promise<number>;
}
