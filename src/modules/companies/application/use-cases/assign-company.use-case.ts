import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { OrganisationsService } from '@modules/organisations/application/organisations.service';
import { UserMapper } from '@modules/users/application/mappers/user.mapper';
import { PublicUser } from '@modules/users/application/user.types';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';

/**
 * 3.x POST /companies/:companyId/managers/:managerId (Super Admin), kept safe for
 * 4.0: it only puts a person who belongs to no organisation into this one (their
 * department, managed departments and grants start empty). Someone already in
 * another organisation is refused with 409 PERSON_IN_ORGANISATION.
 */
@Injectable()
export class AssignCompanyUseCase {
  constructor(
    private readonly organisations: OrganisationsService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async execute(me: AuthenticatedUser, companyId: string, userId: string): Promise<PublicUser> {
    await this.organisations.assignPerson(me, companyId, userId);
    const saved = await this.users.findById(userId);
    if (!saved) throw new NotFoundError('Unknown user');
    return UserMapper.toPublic(saved);
  }
}
