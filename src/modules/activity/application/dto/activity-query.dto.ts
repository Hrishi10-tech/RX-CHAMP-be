import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** Optional local-day filter (defaults to today) for the daily activity view. */
export class ActivityDayQueryDto {
  @ApiPropertyOptional({ description: 'Local day YYYY-MM-DD. Defaults to today.', example: '2026-07-16' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
