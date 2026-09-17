import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '@shared/exceptions/app.exception';
import { CompanyMapper } from '../mappers/company.mapper';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';
import { PublicCompany, UpdateCompanyInput } from '../company.types';

/**
 * Renames a company. The name is all a company holds of its own — its people and
 * their details belong to the users — so this is the whole of editing one.
 *
 * Guards the same uniqueness create does, or two companies could end up sharing a
 * name and nobody could tell which manager belonged to which.
 */
@Injectable()
export class UpdateCompanyUseCase {
  constructor(@Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository) {}

  async execute(id: string, input: UpdateCompanyInput): Promise<PublicCompany> {
    const company = await this.companies.findById(id);
    if (!company) throw new NotFoundError('Unknown company');

    const name = input.name.trim();

    // Saving a company under the name it already has is a no-op, not a clash with
    // itself — only another company holding the name is a conflict.
    const existing = await this.companies.findByName(name);
    if (existing && existing.id !== company.id) {
      throw new ConflictError(`Company '${name}' already exists`);
    }

    const renamed = await this.companies.rename(company.id, name);
    return CompanyMapper.toPublic(renamed);
  }
}
