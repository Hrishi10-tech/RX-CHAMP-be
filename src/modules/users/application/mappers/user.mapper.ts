import { User } from '../../domain/entities/user.entity';
import { PublicUser, UserListItem } from '../user.types';

export class UserMapper {
  static toPublic(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      role: user.role,
      department: user.department,
      designation: user.designation,
      managerId: user.managerId,
      companyId: user.companyId,
      shiftId: user.shiftId,
      shiftStart: user.shiftStart,
      shiftEnd: user.shiftEnd,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    };
  }

  static toListItem(user: User): UserListItem {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      role: user.role,
      department: user.department,
      company: user.companyName,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
