import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsId } from '@shared/validation/is-id';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1'
    ? true
    : value === false || value === 'false' || value === '0'
      ? false
      : value;

export class ClaimCompOffDto {
  @ApiProperty({ example: '2026-11-01', description: 'The extra day worked' })
  @Allow()
  date!: unknown;

  @ApiPropertyOptional({
    example: 1,
    description: '1 (full day) or 0.5 (half day); default: what the day earns',
  })
  @Allow()
  days?: unknown;

  @ApiProperty({
    example: 'Quarter-end close with the finance team',
    description: '3 to 300 characters',
  })
  @Allow()
  reason!: unknown;
}

export class DecideCompOffDto {
  @ApiPropertyOptional({ example: 0.5, description: 'Approve: 1 or 0.5 (at most what was asked)' })
  @Allow()
  days?: unknown;

  @ApiPropertyOptional({
    description: 'Approve: optional. Reject and revoke: required, 3 to 300 characters',
  })
  @Allow()
  note?: unknown;
}

export class GrantCompOffDto {
  @ApiProperty()
  @IsId()
  userId!: string;

  @ApiProperty({ example: '2026-11-01' })
  @Allow()
  date!: unknown;

  @ApiProperty({ example: 1, description: '1 or 0.5' })
  @Allow()
  days!: unknown;

  @ApiProperty({
    example: 'Client site visit on Sunday, not tracked',
    description: '3 to 300 characters',
  })
  @Allow()
  reason!: unknown;
}

export class ListCompOffQueryDto {
  @ApiPropertyOptional({
    description: 'PENDING, APPROVED, REJECTED, CANCELLED, REVOKED; comma-separated',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ description: 'Only claims waiting on the caller' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  needsMe?: boolean;

  @ApiPropertyOptional({ default: 300, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({
    enum: ['DECIDED'],
    description: 'DECIDED: latest decision first, however old the request',
  })
  @IsOptional()
  @IsIn(['DECIDED'])
  order?: 'DECIDED';
}

export class CompOffSummaryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;
}
