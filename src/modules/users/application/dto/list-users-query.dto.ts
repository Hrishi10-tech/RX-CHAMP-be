import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@shared/rbac/roles.enum';
import {
  DEFAULT_USER_SORT,
  USER_SORT_OPTIONS,
  UserSortOption,
} from '../../domain/repositories/user.repository';

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
  search?: string;

  @ApiPropertyOptional({ enum: Role, description: 'Filter by role, e.g. MANAGER' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: "Filter to a manager's team (their reports)" })
  @IsOptional()
  @IsString()
  managerId?: string;

  @ApiPropertyOptional({
    example: 'Marketing',
    description: 'Team / department. Exact match — a user with no team never matches.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @ApiPropertyOptional({ description: 'Company the user belongs to.' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

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
