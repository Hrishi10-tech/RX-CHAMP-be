import { Inject, Injectable } from '@nestjs/common';
import { CompanyMapper } from '../mappers/company.mapper';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';
import { ListManagerUsersQueryDto } from '../dto';
import { ListManagerUsersResult } from '../company.types';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 12;

@Injectable()
export class ListManagerUsersUseCase {
  constructor(@Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository) {}

  async execute(
    companyId: string,
    managerId: string,
    query: ListManagerUsersQueryDto = {},
  ): Promise<ListManagerUsersResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.companies.findManagerUsers(companyId, managerId, {
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.companies.countManagerUsers(companyId, managerId),
    ]);

    return { users: rows.map(CompanyMapper.toManagerUser), total, page, limit };
  }
}
