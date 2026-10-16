import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@shared/rbac/roles.enum';
import { IsId } from '@shared/validation/is-id';

export class CreateUserItemDto {
  @ApiPropertyOptional({ example: 'jane@acme.test' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: 'S3curePass!' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({
    enum: Role,
    example: Role.USER,
    description: 'Role name; backend resolves it to the role_id',
  })
  @IsOptional()
  @IsString()
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  designation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shiftId?: string;

  @ApiPropertyOptional({
    description: 'Super Admin only: who the new person reports to (defaults to the creator).',
  })
  @IsOptional()
  @IsId()
  managerId?: string;

  @ApiPropertyOptional({ example: '10:00' })
  @IsOptional()
  @IsString()
  shiftStart?: string;

  @ApiPropertyOptional({ example: '19:00' })
  @IsOptional()
  @IsString()
  shiftEnd?: string;
}

export class CreateUsersDto extends CreateUserItemDto {
  @ApiPropertyOptional({ type: [CreateUserItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateUserItemDto)
  users?: CreateUserItemDto[];
}
