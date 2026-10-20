import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
}

/** GET /workday/me/history?month=YYYY-MM (4.0). */
export class HistoryQueryDto {
  @ApiPropertyOptional({ example: '2026-10', description: 'Default: the current month' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

/** GET /team (4.0). */
export class TeamQueryDto {
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
