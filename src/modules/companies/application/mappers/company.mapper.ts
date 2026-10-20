import { CompanyWithStats } from '../../domain/repositories/company.repository';
import { PublicCompanyWithStats } from '../company.types';

export class CompanyMapper {
  static toStats(company: CompanyWithStats): PublicCompanyWithStats {
    const joinedOn = company.createdAt.toISOString();
    return {
      id: company.id,
      name: company.name,
      status: 'ACTIVE',
      createdAt: joinedOn,
      joinedOn,
      managerCount: company.managerCount,
      userCount: company.userCount,
      managers: company.managers.map((m) => ({
        id: m.id,
        email: m.email,
        name: m.name,
        joinedOn,
        userCount: m.userCount,
      })),
    };
  }
}
