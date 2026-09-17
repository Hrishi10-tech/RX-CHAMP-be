import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';
import { DeleteCompanyResult } from '../company.types';

/**
 * Removes a company from the app, along with the members still attached to it.
 *
 * Soft delete throughout: every row keeps its history and simply stops being listed,
 * so a company deleted by mistake — and its people's attendance and activity — can be
 * brought back by clearing the stamp. Nothing here destroys data.
 *
 * Deleting a company with members in it is deliberate, not an accident to be blocked:
 * the caller is told the count up front and confirms against it. Returning the number
 * that actually went lets the caller say what happened rather than guess.
 */
@Injectable()
export class DeleteCompanyUseCase {
  constructor(@Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository) {}

  async execute(id: string): Promise<DeleteCompanyResult> {
    const company = await this.companies.findById(id);
    if (!company) throw new NotFoundError('Unknown company');

    const membersRemoved = await this.companies.softDelete(company.id);

    return { deleted: true, id: company.id, name: company.name, membersRemoved };
  }
}
