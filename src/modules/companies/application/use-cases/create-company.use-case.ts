import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { OrganisationsService } from '@modules/organisations/application/organisations.service';
import {
  CompanyAssignmentSummary,
  CreateCompanyInput,
  CreateCompanyResult,
} from '../company.types';

/**
 * 3.x POST /companies, kept as an alias of POST /organisations for one release
 * (docs/4.0/SPEC.md 5.1): same name rules and Super Admin only. `managerIds` puts
 * people who belong to no organisation yet into the new one (moving someone out of
 * another organisation is refused per person, reported in `assignments.errors`).
 */
@Injectable()
export class CreateCompanyUseCase {
  constructor(private readonly organisations: OrganisationsService) {}

  async execute(input: CreateCompanyInput, me: AuthenticatedUser): Promise<CreateCompanyResult> {
    const org = await this.organisations.create(me, input.name);
    const assignments: CompanyAssignmentSummary = { assigned: [], errors: [] };
    for (const managerId of [...new Set(input.managerIds ?? [])]) {
      try {
        await this.organisations.assignPerson(me, org.id, managerId);
        assignments.assigned.push(managerId);
      } catch (err) {
        assignments.errors.push({ managerId, error: (err as Error).message || 'could not assign' });
      }
    }
    return { ...org, assignments };
  }
}
