import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { OrganisationsService } from '@modules/organisations/application/organisations.service';
import { PublicCompany, UpdateCompanyInput } from '../company.types';

/** 3.x PATCH /companies/:id, an alias of PATCH /organisations/:id (4.0 name rules). */
@Injectable()
export class UpdateCompanyUseCase {
  constructor(private readonly organisations: OrganisationsService) {}

  async execute(
    me: AuthenticatedUser,
    id: string,
    input: UpdateCompanyInput,
  ): Promise<PublicCompany> {
    return this.organisations.rename(me, id, input.name);
  }
}
