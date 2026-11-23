import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
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

/** Bodies are checked in the domain (wfh.ts, wfh-policy.ts): plain messages with `details.field`. */
export class WfhRequestDto {
  @ApiProperty({ enum: ['FULL_DAY', 'HALF_DAY', 'QUARTER_DAY'] })
  @Allow()
  kind!: unknown;

  @ApiPropertyOptional({
    enum: ['FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4'],
    description: 'HALF_DAY: FIRST_HALF or SECOND_HALF; QUARTER_DAY: Q1 to Q4; FULL_DAY: none',
  })
  @Allow()
  part?: unknown;

  @ApiProperty({ example: '2026-11-11' })
  @Allow()
  startDate!: unknown;

  @ApiPropertyOptional({
    example: '2026-11-13',
    description: 'FULL_DAY only: the last day of a range',
  })
  @Allow()
  endDate?: unknown;

  @ApiProperty({ example: 'Plumber coming in the morning', description: '3 to 300 characters' })
  @Allow()
  reason!: unknown;
}

export class WfhDecisionDto {
  @ApiPropertyOptional({
    description: 'Approve: optional. Reject and revoke: required, 3 to 300 characters',
  })
  @Allow()
  note?: unknown;
}

export class ListWfhQueryDto {
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

export class WfhSummaryQueryDto {
  @ApiPropertyOptional({ description: 'Super Admin or Super Manager: one organisation' })
  @IsOptional()
  @IsId()
  companyId?: string;
}

export class WfhScheduleDto {
  @ApiProperty({ description: 'The person who works from home on these days' })
  @IsId()
  userId!: string;

  @ApiProperty({
    type: [Number],
    example: [3],
    description: 'ISO weekdays, Monday = 1 to Sunday = 7',
  })
  @Allow()
  weekdays!: unknown;

  @ApiPropertyOptional({
    type: [Number],
    example: [1, 3],
    description: 'Weeks of the month (1 to 5); empty: every week',
  })
  @Allow()
  weeks?: unknown;

  @ApiProperty({ enum: ['FULL_DAY', 'HALF_DAY', 'QUARTER_DAY'] })
  @Allow()
  kind!: unknown;

  @ApiPropertyOptional({ enum: ['FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4'] })
  @Allow()
  part?: unknown;

  @ApiProperty({ example: '2026-11-11', description: 'Today or later' })
  @Allow()
  fromDate!: unknown;

  @ApiPropertyOptional({ example: '2027-03-31', description: 'Empty: until it is ended' })
  @Allow()
  toDate?: unknown;

  @ApiPropertyOptional({ example: 'Agreed for the move' })
  @Allow()
  note?: unknown;
}

export class WfhScheduleUpdateDto {
  @ApiProperty({ type: [Number], example: [3] })
  @Allow()
  weekdays!: unknown;

  @ApiPropertyOptional({ type: [Number], example: [] })
  @Allow()
  weeks?: unknown;

  @ApiProperty({ enum: ['FULL_DAY', 'HALF_DAY', 'QUARTER_DAY'] })
  @Allow()
  kind!: unknown;

  @ApiPropertyOptional({ enum: ['FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4'] })
  @Allow()
  part?: unknown;

  @ApiProperty({
    example: '2026-11-11',
    description: 'A schedule that has begun restarts from today at the earliest',
  })
  @Allow()
  fromDate!: unknown;

  @ApiPropertyOptional({ example: null })
  @Allow()
  toDate?: unknown;

  @ApiPropertyOptional()
  @Allow()
  note?: unknown;
}

export class WfhScheduleSkipDto {
  @ApiProperty({ example: '2026-11-18', description: 'Today or later' })
  @IsDateKey()
  date!: string;

  @ApiPropertyOptional({ default: true, description: 'false: put the day back' })
  @IsOptional()
  @IsBoolean()
  skip?: boolean;
}

export class ListWfhSchedulesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional({ description: 'Super Admin or Super Manager: one organisation' })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ description: 'Ended schedules too' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeEnded?: boolean;
}

export class PatchWfhPolicyDto {
  @ApiPropertyOptional() @Allow() enabled?: unknown;
  @ApiPropertyOptional({ example: 1, description: 'Days ahead (0 to 30); 0 allows the same day' })
  @Allow()
  noticeDays?: unknown;
  @ApiPropertyOptional({ example: null, nullable: true, description: '1 to 31; null: no cap' })
  @Allow()
  maxDaysPerMonth?: unknown;
  @ApiPropertyOptional({
    enum: ['MANAGER', 'SUPER_MANAGER', 'SUPER_ADMIN'],
    description: 'Super Admin only',
  })
  @Allow()
  approver?: unknown;
  @ApiPropertyOptional({ enum: ['SHIFT_LENGTH', 'EXPECTED'] })
  @Allow()
  creditBasis?: unknown;
}
