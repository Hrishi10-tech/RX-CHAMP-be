import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@shared/rbac/roles.enum';

export class CreateRoleDto {
  @ApiProperty({ enum: Role, example: Role.MANAGER })
  @IsEnum(Role)
  name!: Role;

  @ApiPropertyOptional({ type: [String], example: ['CREATE_USER', 'VIEW_REPORT'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}
