import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { IsId } from '@shared/validation/is-id';
import { IsDateKey, IsMonthKey } from '@shared/validation/date-key';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** POST /screenshots/exports/report (and /estimate): one person's screenshots as a PDF. */
export class ScreenshotReportDto {
  @ApiProperty({ description: 'Whose screenshots' })
  @IsId()
  userId!: string;

  @ApiProperty({
    enum: ['DAY', 'RANGE', 'MONTH', 'TIME_WINDOW'],
    description:
      'DAY: one date. RANGE: fromDate to toDate (up to 62 days). MONTH: a whole month. ' +
      'TIME_WINDOW: a time of day on one date (fromTime to toTime, e.g. 17:00 to 19:00).',
  })
  @IsIn(['DAY', 'RANGE', 'MONTH', 'TIME_WINDOW'])
  mode!: 'DAY' | 'RANGE' | 'MONTH' | 'TIME_WINDOW';

  @ApiPropertyOptional({ example: '2026-10-14' })
  @IsOptional()
  @IsDateKey()
  date?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateKey()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-10-07' })
  @IsOptional()
  @IsDateKey()
  toDate?: string;

  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @IsMonthKey()
  month?: string;

  @ApiPropertyOptional({ example: '17:00' })
  @IsOptional()
  @IsString()
  @Matches(HM, { message: 'fromTime must be a time like 17:00' })
  fromTime?: string;

  @ApiPropertyOptional({ example: '19:00' })
  @IsOptional()
  @IsString()
  @Matches(HM, { message: 'toTime must be a time like 19:00' })
  toTime?: string;
}

/** POST /screenshots/archives/:month/archive and /delete */
export class MonthParamDto {
  @ApiProperty({ example: '2026-01' })
  @IsMonthKey()
  month!: string;
}
