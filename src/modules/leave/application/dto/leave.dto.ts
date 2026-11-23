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
import { IsDateKey } from '@shared/validation/date-key';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1'
    ? true
    : value === false || value === 'false' || value === '0'
      ? false
      : value;

/**
 * Bodies are checked in the domain (request-rules.ts, leave-policy.ts), so every
 * refusal carries the same plain message and `details.field`; the DTOs only let
 * the fields through.
 */
export class LeaveRequestDto {
  @ApiProperty({
    enum: ['CLSL', 'ELPL', 'COMPOFF'],
    description: 'COMPOFF (3.5): taken against comp off credits',
  })
  @Allow()
  category!: unknown;

  @ApiProperty({ enum: ['FULL_DAY', 'HALF_DAY', 'QUARTER_DAY'] })
  @Allow()
  kind!: unknown;

  @ApiPropertyOptional({
    enum: ['FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4'],
    description: 'HALF_DAY: FIRST_HALF or SECOND_HALF; QUARTER_DAY: Q1 to Q4; FULL_DAY: none',
  })
  @Allow()
  part?: unknown;

  @ApiProperty({ example: '2026-11-09' })
  @Allow()
  startDate!: unknown;

  @ApiPropertyOptional({
    example: '2026-11-13',
    description: 'FULL_DAY ranges only; at most 31 days, one year',
  })
  @Allow()
  endDate?: unknown;

  @ApiProperty({ example: 'Family function', description: '3 to 300 characters' })
  @Allow()
  reason!: unknown;
}

export class LeavePreviewDto extends LeaveRequestDto {}

export class LeaveDecisionDto {
  @ApiPropertyOptional({
    description: 'Approve: optional. Reject and revoke: required, 3 to 300 characters',
  })
  @Allow()
  note?: unknown;
}

export class MyLeaveQueryDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class ListLeaveQueryDto {
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

  @ApiPropertyOptional({ description: 'Super Admin or Super Manager: one organisation' })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ description: "Super Admin or Super Manager: one manager's team" })
  @IsOptional()
  @IsId()
  managerId?: string;

  @ApiPropertyOptional({ example: '2026-11-01', description: 'Requests overlapping from..to' })
  @IsOptional()
  @IsDateKey()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsDateKey()
  to?: string;

  @ApiPropertyOptional({ enum: ['CLSL', 'ELPL', 'COMPOFF'] })
  @IsOptional()
  @IsIn(['CLSL', 'ELPL', 'COMPOFF'])
  category?: string;

  @ApiPropertyOptional({ description: 'Only requests waiting on the caller' })
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
}

export class LeaveSummaryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;
}

export class BalancesQueryDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  managerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

export class SetQuotaDto {
  @ApiPropertyOptional({
    example: 15,
    nullable: true,
    description: 'Yearly CL/SL days; null = the policy default',
  })
  @Allow()
  clslDaysPerYear?: unknown;

  @ApiPropertyOptional({
    example: 12,
    nullable: true,
    description: 'Yearly EL/PL days; null = the policy default',
  })
  @Allow()
  elplDaysPerYear?: unknown;
}

export class AdjustLeaveDto {
  @ApiProperty()
  @IsId()
  userId!: string;

  @ApiProperty({ enum: ['CLSL', 'ELPL'] })
  @Allow()
  category!: unknown;

  @ApiPropertyOptional({
    example: 2026,
    description: 'Last year, this year (default) or next year',
  })
  @Allow()
  year?: unknown;

  @ApiProperty({ enum: ['ADD', 'SUBTRACT', 'SET'] })
  @Allow()
  mode!: unknown;

  @ApiProperty({
    example: 1.5,
    description: 'Quarter days. ADD and SUBTRACT: more than 0; SET: the balance wanted',
  })
  @Allow()
  days!: unknown;

  @ApiProperty({
    example: 'Leave taken in October before RX Vision',
    description: '5 to 300 characters',
  })
  @Allow()
  reason!: unknown;
}

export class AdjustmentsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ default: 200, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class PatchLeavePolicyDto {
  @ApiPropertyOptional() @Allow() enabled?: unknown;
  @ApiPropertyOptional({ example: 12 }) @Allow() clslDaysPerYear?: unknown;
  @ApiPropertyOptional({ example: 12 }) @Allow() elplDaysPerYear?: unknown;
  @ApiPropertyOptional({ example: null, nullable: true }) @Allow() elplCarryCapDays?: unknown;
  @ApiPropertyOptional({ example: 5 }) @Allow() elplNoticeDays?: unknown;
  @ApiPropertyOptional({ example: 7 }) @Allow() clslBackdateDays?: unknown;
  @ApiPropertyOptional({
    enum: ['MANAGER', 'SUPER_MANAGER', 'SUPER_ADMIN'],
    description: 'Super Admin only',
  })
  @Allow()
  approver?: unknown;
  @ApiPropertyOptional() @Allow() prorateJoiners?: unknown;

  // ---- Comp off (3.5) ----
  @ApiPropertyOptional({ example: true }) @Allow() compOffEnabled?: unknown;
  @ApiPropertyOptional({ example: 60, description: 'Days after the day worked (1 to 365)' })
  @Allow()
  compOffValidityDays?: unknown;
  @ApiPropertyOptional({ example: 80 }) @Allow() compOffFullDayPct?: unknown;
  @ApiPropertyOptional({ example: 40 }) @Allow() compOffHalfDayPct?: unknown;
  @ApiPropertyOptional({ example: 30, description: 'Days after the day worked (1 to 90)' })
  @Allow()
  compOffClaimWithinDays?: unknown;
  @ApiPropertyOptional({
    enum: ['MANAGER', 'SUPER_MANAGER', 'SUPER_ADMIN'],
    description: 'Who decides comp off claims (Super Admin only)',
  })
  @Allow()
  compOffApprover?: unknown;
  @ApiPropertyOptional({ example: true }) @Allow() compOffCountLeaveDays?: unknown;
  @ApiPropertyOptional({ example: null, nullable: true, description: 'Days; null: no cap' })
  @Allow()
  compOffMaxBalanceDays?: unknown;

  @ApiPropertyOptional({
    description:
      'Yearly days, pro rata or cap changed: true applies it to this year too (everyone on the default); ' +
      'years not started yet always follow',
  })
  @IsOptional()
  @IsBoolean()
  applyNow?: boolean;
}
