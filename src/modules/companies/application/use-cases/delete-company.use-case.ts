import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { OrganisationsService } from '@modules/organisations/application/organisations.service';
import { DeleteCompanyResult } from '../company.types';

/**
 * 3.x DELETE /companies/:id, an alias of DELETE /organisations/:id. 4.0 change: a
 * company with active people is no longer deleted along with them; it answers 409
 * ORG_NOT_EMPTY. Blocked people still go with it (soft delete, same stamp).
 */
@Injectable()
export class DeleteCompanyUseCase {
  constructor(private readonly organisations: OrganisationsService) {}

  async execute(me: AuthenticatedUser, id: string): Promise<DeleteCompanyResult> {
    return this.organisations.remove(me, id);
  }
}
