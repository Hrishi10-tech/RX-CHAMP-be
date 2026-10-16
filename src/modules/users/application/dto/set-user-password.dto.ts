import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SetUserPasswordDto {
  @ApiProperty({ minLength: 8, maxLength: 128, description: 'A temporary password to hand over' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Also end every session they have, the agent included (use when the account may be compromised)',
  })
  @IsOptional()
  @IsBoolean()
  signOutEverywhere?: boolean;
}
