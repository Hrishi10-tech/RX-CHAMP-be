import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** Query for the manager team-summary endpoint — an optional local day (defaults to today). */
export class PresenceSummaryQueryDto {
  @ApiPropertyOptional({
    description: 'Local calendar day to summarise, as YYYY-MM-DD. Defaults to today.',
    example: '2026-07-11',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;
}
