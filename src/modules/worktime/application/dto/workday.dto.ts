import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  IsIn,
  Matches,
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsId } from '@shared/validation/is-id';
import { IsDateKey } from '@shared/validation/date-key';

/** POST /activity/start-day */
export class StartDayDto {
  @ApiPropertyOptional({
    description:
      'When work began. Accepted only within the last 10 minutes and not in the future; ' +
      'otherwise the server uses now.',
    example: '2026-10-14T03:58:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @ApiPropertyOptional({
    description:
      'Why the day starts late (3.2 agents). Asked for when Start Day comes later than the ' +
      'shift start plus the late-start grace (422 LATE_REASON_REQUIRED).',
    example: 'Traffic on the ring road',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  lateReason?: string;
}

/** POST /workday/me/late-reason */
export class LateReasonDto {
  @ApiPropertyOptional({ description: 'The working day (default: today)', example: '2026-10-14' })
  @IsOptional()
  @IsDateKey()
  date?: string;

  @ApiProperty({ description: 'Why the day started late', example: 'Traffic on the ring road' })
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class EndDayCommentDto {
  @ApiProperty({ description: 'A skipped break record waiting for a comment' })
  @IsId()
  breakId!: string;

  @ApiProperty({ description: 'The comment: reasonMinChars to 500 characters' })
  @IsString()
  // Generous cap here: a longer comment fails the whole call with 422 COMMENT_INVALID.
  @MaxLength(2000)
  comment!: string;
}

/** POST /activity/end-day */
export class EndDayDto {
  @ApiPropertyOptional({ type: [EndDayCommentDto], maxItems: 100 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EndDayCommentDto)
  comments?: EndDayCommentDto[];
}

/** ?date= on day views (default today). */
export class DayQueryDto {
  @ApiPropertyOptional({ example: '2026-10-14' })
  @IsOptional()
  @IsDateKey()
  date?: string;
}

/** GET /team/today */
export class TeamTodayQueryDto extends DayQueryDto {
  @ApiPropertyOptional({ description: "Super Admin: one manager's team" })
  @IsOptional()
  @IsId()
  managerId?: string;

  @ApiPropertyOptional({
    description: "4.0: one department (one of the caller's; another organisation's is 404)",
  })
  @IsOptional()
  @IsId()
  departmentId?: string;

  @ApiPropertyOptional({
    description:
      '3.3: Super Manager or Super Admin on "All organisations": one organisation ' +
      '(managerId and departmentId need one)',
  })
  @IsOptional()
  @IsId()
  companyId?: string;
}

/** GET /workday/me/history?month=YYYY-MM (4.0). */
export class HistoryQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'Default: the current month' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

/** GET /team (4.0). */
/** Paging for lists built in memory: 1-based page, limit 1..100. Bad values fall back to the defaults. */
export const PAGE_DEFAULT_LIMIT = 10;
export const PAGE_MAX_LIMIT = 100;

export class PageQueryDto {
  // Kept as strings and read by parsePageParams, so `abc` or `-5` falls back to the
  // default instead of failing the request.
  @ApiPropertyOptional({ description: 'Page number, from 1', default: 1 })
  @Allow()
  page?: string;

  @ApiPropertyOptional({
    description: `People per page, 1..${PAGE_MAX_LIMIT}`,
    default: PAGE_DEFAULT_LIMIT,
  })
  @Allow()
  limit?: string;
}

/** GET /overview: page and limit apply to the departments list only. */
export class OverviewQueryDto extends PageQueryDto {}

export class TeamQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['active', 'all'])
  view?: 'active' | 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Part of a name, email or designation' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
