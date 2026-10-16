import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BREAK_KINDS, BreakKind } from '../../domain/shift.types';
import { REASON_MAX_CHARS } from '../../domain/break-schedule';
import { IsId } from '@shared/validation/is-id';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class StartBreakDto {
  @ApiProperty({ enum: BREAK_KINDS })
  @IsIn(BREAK_KINDS)
  kind!: BreakKind;

  @ApiPropertyOptional({
    description: 'Required when starting early or late (per the shift rules)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  reason?: string;
}

export class EndBreakDto {
  @ApiPropertyOptional({
    description:
      'Why the break ran over. With askToCount true it needs reasonMinChars. Agents before ' +
      '3.1 send only this: a non-empty reason over the grace counts as asking.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  overrunReason?: string;

  @ApiPropertyOptional({
    description:
      'Back later than the grace allows: true asks the manager to count the minutes over ' +
      'as focus time (PENDING); false leaves them out (no approval).',
  })
  @IsOptional()
  @IsBoolean()
  askToCount?: boolean;
}

export class SkipBreakDto {
  @ApiProperty({ enum: BREAK_KINDS })
  @IsIn(BREAK_KINDS)
  kind!: BreakKind;

  @ApiPropertyOptional({
    description:
      'Why the break is skipped: at least the shift reasonMinChars (not for a Super Admin)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  reason?: string;
}

export class CommentSkipDto {
  @ApiProperty({ description: 'The comment on a skip: reasonMinChars to 500 characters' })
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  comment!: string;
}

export const APPROVAL_STATUS_FILTERS = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const;
export type ApprovalStatusFilter = (typeof APPROVAL_STATUS_FILTERS)[number];

export class ApprovalsQueryDto {
  @ApiPropertyOptional({ example: '2026-10-13', description: 'Local day (default: any)' })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ enum: APPROVAL_STATUS_FILTERS, default: 'PENDING' })
  @IsOptional()
  @IsIn(APPROVAL_STATUS_FILTERS)
  status?: ApprovalStatusFilter = 'PENDING';

  @ApiPropertyOptional({
    enum: ['mine', 'all'],
    default: 'mine',
    description: "Super Admin: 'all' = every team",
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all' = 'mine';

  @ApiPropertyOptional({ description: 'Only pending items from before today' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

export class DecideBreakDto {
  @ApiPropertyOptional({ description: 'Required to reject; the staff member sees it' })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  note?: string;
}

export class RejectBreakDto {
  @ApiProperty({ description: 'Why it was rejected; the staff member sees it' })
  @IsString()
  @MinLength(3)
  @MaxLength(REASON_MAX_CHARS)
  note!: string;
}

export class BulkApproveDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsId({ each: true })
  ids!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_CHARS)
  note?: string;
}

export class TeamBreaksQueryDto {
  @ApiPropertyOptional({ example: '2026-10-13' })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: "Super Admin: limit to one manager's team" })
  @IsOptional()
  @IsId()
  managerId?: string;
}

export class SummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-10-13', description: 'Local day (default: today)' })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class MyHistoryQueryDto {
  @ApiPropertyOptional({ default: 14, maximum: 31 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number = 14;
}
