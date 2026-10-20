import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@shared/rbac/roles.enum';
import { UserStatus } from '@shared/types/user.types';
import {
  DEFAULT_USER_SORT,
  USER_SORT_OPTIONS,
  UserSortOption,
} from '../../domain/repositories/user.repository';
import { IsId } from '@shared/validation/is-id';

const USER_STATUSES: UserStatus[] = ['ACTIVE', 'DISABLED'];

/**
 * GET /users (docs/4.0/SPEC.md 5.3). Filters combine; the caller's scope always
 * wins (an Admin: their organisation; a Manager: Staff of their departments; Staff:
 * themselves), whatever is asked.
 */
export class ListUsersQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Matches name or email (case-insensitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Same as q (3.x name)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: Role, description: 'Filter by role, e.g. MANAGER' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: 'People of one department (a Manager: one of theirs)' })
  @IsOptional()
  @IsId({ message: 'departmentId must be a department id' })
  departmentId?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  @ApiPropertyOptional({
    example: 'Marketing',
    description: '3.x: department name, exact match.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Earliest join date (YYYY-MM-DD), inclusive — counts the whole day.',
  })
  @IsOptional()
  @IsDateString()
  joinedFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Latest join date (YYYY-MM-DD), inclusive — counts the whole day.',
  })
  @IsOptional()
  @IsDateString()
  joinedTo?: string;

  @ApiPropertyOptional({
    enum: USER_SORT_OPTIONS,
    default: DEFAULT_USER_SORT,
    description:
      'Ordering. name_asc = Name (A–Z), name_desc = Name (Z–A), ' +
      'joined_desc = Joined Date (Newest), joined_asc = Joined Date (Oldest), ' +
      'role_asc = Role (A–Z), role_desc = Role (Z–A).',
  })
  @IsOptional()
  @IsIn(USER_SORT_OPTIONS)
  sort?: UserSortOption;
}
