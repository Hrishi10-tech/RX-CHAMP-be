import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Role } from '@shared/rbac/roles.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@shared/types/user.types';
import { IsId } from '@shared/validation/is-id';
import { GrantsInputDto } from './create-user.dto';

const USER_STATUSES: UserStatus[] = ['ACTIVE', 'DISABLED'];

/** PATCH /users/:id (docs/4.0/SPEC.md 5.3). Missing fields stay as they are. */
export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'jane@acme.test',
    description: 'The sign-in address. Must be unique; stored lowercased.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Enter a first name.' })
  @MaxLength(60)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Empty string clears it.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  designation?: string;

  @ApiPropertyOptional({
    enum: [Role.MANAGER, Role.USER],
    description: "Manager or Staff. An organisation's Admin is created from Organisations only.",
  })
  @IsOptional()
  @IsIn([Role.MANAGER, Role.USER], {
    message: "role must be MANAGER or USER. An organisation's Admin is created from Organisations.",
  })
  role?: Role;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Staff: their department. Manager: their own (null clears it).',
  })
  @IsOptional()
  @IsId({ message: 'departmentId must be a department id' })
  departmentId?: string | null;

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
}

export class SetUserStatusDto {
  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsIn(USER_STATUSES)
  status!: UserStatus;
}

export class SetUserScreenshotsDto {
  @ApiProperty({
    example: false,
    description:
      'Whether the agent takes automatic screenshots for this user. False stops only ' +
      'that periodic capture — activity tracking and manual capture are unaffected.',
  })
  @IsBoolean()
  enabled!: boolean;
}

/** POST /users/:id/grants: a Manager's view grants, all three. */
export class SetUserGrantsDto {
  @ApiProperty()
  @IsBoolean({ message: 'screenshots must be true or false' })
  screenshots!: boolean;

  @ApiProperty()
  @IsBoolean({ message: 'timeline must be true or false' })
  timeline!: boolean;

  @ApiProperty()
  @IsBoolean({ message: 'activity must be true or false' })
  activity!: boolean;
}

/** POST /users/:id/idle: the person's input-tracking override (null = use the department's). */
export class SetUserIdleDto {
  @ApiPropertyOptional({ nullable: true, description: 'null = use the department setting' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsBoolean({ message: 'enabled must be true, false or null' })
  enabled?: boolean | null;

  @ApiPropertyOptional({ nullable: true, minimum: 2, maximum: 60 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt({ message: 'minutes must be a whole number or null' })
  @Min(2, { message: 'minutes must be from 2 to 60' })
  @Max(60, { message: 'minutes must be from 2 to 60' })
  minutes?: number | null;
}
