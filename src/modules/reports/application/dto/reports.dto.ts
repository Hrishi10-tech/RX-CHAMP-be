import { Injectable, PipeTransform } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional } from 'class-validator';
import { ValidationError } from '@shared/exceptions/app.exception';
import { IsDateKey, IsMonthKey, isValidMonthKey, splitList } from '@shared/validation/date-key';
import { IsId } from '@shared/validation/is-id';

/** At most this many people may be named in `userIds`. */
export const MAX_REPORT_USER_IDS = 500;

/** ?month= (default: the current month in business time). */
export class MonthQueryDto {
  @ApiPropertyOptional({ example: '2026-09', description: 'Default: the current month' })
  @IsOptional()
  @IsMonthKey()
  month?: string;
}

/** GET /reports/person/:userId/day */
export class PersonDayQueryDto {
  @ApiPropertyOptional({ example: '2026-09-14', description: 'Default: today' })
  @IsOptional()
  @IsDateKey()
  date?: string;
}

const USER_IDS_DOC = {
  description: 'Only these people, comma-separated (each must be in your scope, else 403)',
  example: '6f1c2a3b-0000-4000-8000-000000000001,6f1c2a3b-0000-4000-8000-000000000002',
  type: String,
};

/** GET /reports/team/day */
export class TeamDayQueryDto extends PersonDayQueryDto {
  @ApiPropertyOptional(USER_IDS_DOC)
  @IsOptional()
  @Transform(({ value }) => splitList(value))
  @IsArray()
  @ArrayMaxSize(MAX_REPORT_USER_IDS)
  @IsId({ each: true })
  userIds?: string[];

  @ApiPropertyOptional({
    description: '4.0: only this department (one the caller may see, else 404)',
  })
  @IsOptional()
  @IsId()
  departmentId?: string;
}

/** GET /reports/team/month and its export */
export class TeamMonthQueryDto extends MonthQueryDto {
  @ApiPropertyOptional({
    description: "3.x: one manager's team. Ignored since 4.0 (use departmentId)",
  })
  @IsOptional()
  @IsId()
  managerId?: string;

  @ApiPropertyOptional(USER_IDS_DOC)
  @IsOptional()
  @Transform(({ value }) => splitList(value))
  @IsArray()
  @ArrayMaxSize(MAX_REPORT_USER_IDS)
  @IsId({ each: true })
  userIds?: string[];

  @ApiPropertyOptional({
    description: '4.0: only this department (one the caller may see, else 404)',
  })
  @IsOptional()
  @IsId()
  departmentId?: string;
}

/** The `:month` path segment: "YYYY-MM", else 400 VALIDATION_ERROR (details.field "month"). */
@Injectable()
export class ParseMonthPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isValidMonthKey(value)) {
      throw new ValidationError('month must be a month as YYYY-MM').withDetails({ field: 'month' });
    }
    return value;
  }
}

/** GET /reports/person/:id/timesheet?from&to (4.0; at most 366 days). */
export class TimesheetQueryDto {
  @ApiProperty({ example: '2026-09-01' })
  @IsDateKey()
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  @IsDateKey()
  to!: string;
}
