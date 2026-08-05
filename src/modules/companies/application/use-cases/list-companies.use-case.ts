import { Inject, Injectable } from '@nestjs/common';
import { CompanyMapper } from '../mappers/company.mapper';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';
import { ListCompaniesQueryDto } from '../dto';
import { ListCompaniesResult } from '../company.types';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

@Injectable()
export class ListCompaniesUseCase {
  constructor(@Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository) {}

  async execute(query: ListCompaniesQueryDto = {}): Promise<ListCompaniesResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filter = { search: query.search, skip: (page - 1) * limit, take: limit };

    const [rows, total] = await Promise.all([
      this.companies.findAllWithStats(filter),
      this.companies.count({ search: query.search }),
    ]);

    return { companies: rows.map(CompanyMapper.toStats), total, page, limit };
  }
}
