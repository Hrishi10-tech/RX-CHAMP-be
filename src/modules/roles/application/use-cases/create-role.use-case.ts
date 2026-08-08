import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, ValidationError } from '@shared/exceptions/app.exception';
import { Permission } from '@shared/rbac/permissions.enum';
import { RoleMapper } from '../mappers/role.mapper';
import { CreateRoleInput, PublicRole } from '../role.types';
import { ROLE_REPOSITORY, RoleRepository } from '../../domain/repositories/role.repository';

const VALID_PERMISSIONS = new Set<string>(Object.values(Permission));

@Injectable()
export class CreateRoleUseCase {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository) {}

  async execute(input: CreateRoleInput): Promise<PublicRole> {
    const existing = await this.roles.findByName(input.name);
    if (existing) {
      throw new ConflictError(`Role '${input.name}' already exists`);
    }

    const missing = input.permissionCodes.filter((c) => !VALID_PERMISSIONS.has(c));
    if (missing.length) {
      throw new ValidationError(`Unknown permission(s): ${missing.join(', ')}`);
    }

    const role = await this.roles.create({
      name: input.name,
      permissionCodes: input.permissionCodes,
    });
    return RoleMapper.toPublic(role);
  }
}
