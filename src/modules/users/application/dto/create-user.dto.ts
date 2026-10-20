import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@shared/rbac/roles.enum';
import { IsId } from '@shared/validation/is-id';

/** A Manager's view grants (docs/4.0/SPEC.md 2.2); a missing one stays as it is. */
export class GrantsInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'screenshots must be true or false' })
  screenshots?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'timeline must be true or false' })
  timeline?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'activity must be true or false' })
  activity?: boolean;
}

/**
 * One person to add (docs/4.0/SPEC.md 5.3). Types and sizes are checked here; the
 * rules (required fields, departments of the organisation, roles) are checked per
 * row by the use case, so a bulk upload reports each bad row instead of failing.
 * The organisation is always the caller's: any companyId sent is ignored.
 */
export class CreateUserItemDto {
  @ApiPropertyOptional({ example: 'jane@acme.test' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: 'Jane' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastName?: string;

  @ApiPropertyOptional({ example: 'S3curePass!' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({ enum: [Role.MANAGER, Role.USER], example: Role.USER })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  role?: string;

  @ApiPropertyOptional({ example: 'Firmware engineer' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  designation?: string;

  @ApiPropertyOptional({
    description: 'Staff: their department (required). Manager: their own (optional).',
  })
  @IsOptional()
  @IsId({ message: 'departmentId must be a department id' })
  departmentId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Manager: the departments they oversee (at least one).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsId({ each: true, message: 'departmentIds must hold department ids' })
  departmentIds?: string[];

  @ApiPropertyOptional({ type: GrantsInputDto, description: 'Manager only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => GrantsInputDto)
  grants?: GrantsInputDto;

  @ApiPropertyOptional({
    description: "A personal shift from today (the organisation's, or a shared legacy shift)",
  })
  @IsOptional()
  @IsId({ message: 'shiftId must be a shift id' })
  shiftId?: string;

  @ApiPropertyOptional({ example: '10:00', description: '3.x: used only when no shift is chosen' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  shiftStart?: string;

  @ApiPropertyOptional({ example: '19:00', description: '3.x: used only when no shift is chosen' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  shiftEnd?: string;
}

export class CreateUsersDto extends CreateUserItemDto {
  @ApiPropertyOptional({ type: [CreateUserItemDto], description: 'Bulk: several people at once' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateUserItemDto)
  users?: CreateUserItemDto[];
}
