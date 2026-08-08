import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { UserMapper } from '@modules/users/application/mappers/user.mapper';
import { PublicUser } from '@modules/users/application/user.types';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';

@Injectable()
export class AssignCompanyUseCase {
  constructor(
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(me: AuthenticatedUser, companyId: string, userId: string): Promise<PublicUser> {
    const company = await this.companies.findById(companyId);
    if (!company) throw new NotFoundError('Unknown company');

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('Unknown user');

    user.assignCompany(company.id, company.name);
    const saved = await this.users.save(user);

    await this.events.publish(
      CompanyAssignedEvent.eventName,
      new CompanyAssignedEvent(saved.id, saved.role, company.id, company.name, me.id, new Date()),
    );

    return UserMapper.toPublic(saved);
  }
}
