import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { Role } from '@shared/rbac/roles.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@shared/types/user.types';
import { IsId } from '@shared/validation/is-id';

const USER_STATUSES: UserStatus[] = ['ACTIVE', 'DISABLED'];

export class UpdateUserDto {
  @ApiPropertyOptional({
    example: 'jane@acme.test',
    description: 'The sign-in address. Must be unique; stored lowercased.',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  designation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ enum: Role, description: 'Super Admin only.' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({
    description: 'Super Admin only. Who this person reports to; empty string clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== '')
  @IsId()
  managerId?: string;
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
