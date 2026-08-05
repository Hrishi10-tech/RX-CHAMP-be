
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import { CompanyMapper } from '../mappers/company.mapper';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../domain/repositories/company.repository';
import {
  CompanyAssignmentSummary,
  CreateCompanyInput,
  CreateCompanyResult,
} from '../company.types';

@Injectable()
export class CreateCompanyUseCase {
  constructor(
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(input: CreateCompanyInput, me: AuthenticatedUser): Promise<CreateCompanyResult> {
    const name = input.name.trim();

    const existing = await this.companies.findByName(name);
    if (existing) {
      throw new ConflictError(`Company '${name}' already exists`);
    }

    const company = await this.companies.create({ name });

    const assignments = await this.assignManagers(company.id, company.name, input.managerIds, me);

    return { ...CompanyMapper.toPublic(company), assignments };
  }

  private async assignManagers(
    companyId: string,
    companyName: string,
    managerIds: string[] | undefined,
    me: AuthenticatedUser,
  ): Promise<CompanyAssignmentSummary> {
    const summary: CompanyAssignmentSummary = { assigned: [], errors: [] };
    if (!managerIds?.length) return summary;

    for (const managerId of managerIds) {
      const user = await this.users.findById(managerId);
      if (!user) {
        summary.errors.push({ managerId, error: 'unknown user' });
        continue;
      }

      user.assignCompany(companyId, companyName);
      const saved = await this.users.save(user);
      summary.assigned.push(saved.id);

      await this.events.publish(
        CompanyAssignedEvent.eventName,
        new CompanyAssignedEvent(
          saved.id,
          saved.role,
          companyId,
          companyName,
          me.id,
          new Date(),
        ),
      );
    }

    return summary;
  }
}
