import { IsBoolean, IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@shared/types/user.types';

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
