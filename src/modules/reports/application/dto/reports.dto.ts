import { Injectable, PipeTransform } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
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
}

/** GET /reports/team/month and its export */
export class TeamMonthQueryDto extends MonthQueryDto {
  @ApiPropertyOptional({
    description: "Super Admin: one manager's team (a Manager may only name themselves)",
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
