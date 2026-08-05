
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { UpdateUserDto } from '../dto';

@Injectable()
export class UpdateUserUseCase {
  private readonly access = new UserAccessService();

  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(me: AuthenticatedUser, targetId: string, dto: UpdateUserDto): Promise<PublicUser> {
    if (me.role === Role.USER && targetId !== me.id) throw new ForbiddenError('Not allowed');

    const target = await this.users.findById(targetId);
    if (!target || (!this.access.ownsTarget(me, target) && target.id !== me.id)) {
      throw new NotFoundError('Unknown user');
    }

    if (dto.email !== undefined && target.changeEmail(dto.email)) {
      // changeEmail returns false when it's the same address, so we only pay for
      // the lookup on a real change — and never conflict a user with themselves.
      const holder = await this.users.findByEmail(target.email);
      if (holder && holder.id !== target.id) {
        throw new ConflictError(`Email '${target.email}' is already in use`);
      }
    }

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      target.rename(dto.firstName ?? target.firstName, dto.lastName ?? target.lastName);
    }
    if (dto.designation !== undefined) target.setDesignation(dto.designation);
    if (dto.department !== undefined) target.setDepartment(dto.department);

    const saved = await this.users.save(target);
    return UserMapper.toPublic(saved);
  }
}
