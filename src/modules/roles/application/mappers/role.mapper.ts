// Maps the RoleRecord read model to the PUBLIC API shape.
import { RoleRecord } from '../../domain/repositories/role.repository';
import { PublicRole } from '../role.types';

export class RoleMapper {
  static toPublic(role: RoleRecord): PublicRole {
    return {
      id: role.id,
      name: role.name,
      permissions: role.permissions,
      createdAt: role.createdAt.toISOString(),
    };
  }
}
