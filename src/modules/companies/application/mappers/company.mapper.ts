import {
  CompanyRecord,
  CompanyWithStats,
  ManagerUserRecord,
} from '../../domain/repositories/company.repository';
import {
  PublicCompany,
  PublicCompanyWithStats,
  PublicManagerUser,
} from '../company.types';

export class CompanyMapper {
  static toPublic(company: CompanyRecord): PublicCompany {
    return {
      id: company.id,
      name: company.name,
      createdAt: company.createdAt.toISOString(),
    };
  }

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

  static toManagerUser(user: ManagerUserRecord): PublicManagerUser {
    return { id: user.id, name: user.name, role: user.role };
  }
}
