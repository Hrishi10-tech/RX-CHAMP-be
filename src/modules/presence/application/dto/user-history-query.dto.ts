import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Query for the per-report presence history endpoint — how many days back to include. */
export class UserHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Number of days (including today) to return, oldest first. 1–31, default 7.',
    default: 7,
    minimum: 1,
    maximum: 31,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number;
}
