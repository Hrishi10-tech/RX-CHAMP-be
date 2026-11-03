import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /super-managers (3.3): a Super Manager account. It belongs to no
 * organisation, so there is no department, role or grants to send. Types and
 * sizes here; the rules (required, lengths, email, password) in the use case.
 */
export class CreateSuperManagerDto {
  @ApiProperty({ example: 'Asha' })
  @IsString()
  @MaxLength(200)
  firstName!: string;

  @ApiProperty({ example: 'Raman' })
  @IsString()
  @MaxLength(200)
  lastName!: string;

  @ApiProperty({ example: 'asha@example.com' })
  @IsString()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({ example: 'Operations lead' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  designation?: string;
}
