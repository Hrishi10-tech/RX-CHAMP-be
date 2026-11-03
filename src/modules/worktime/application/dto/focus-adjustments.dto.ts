import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Allow, IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsId } from '@shared/validation/is-id';
import { IsDateKey, IsMonthKey } from '@shared/validation/date-key';

/** POST /focus-adjustments (Super Manager) */
export class AdjustFocusDto {
  @ApiProperty({ description: 'Whose day' })
  @IsId()
  userId!: string;

  @ApiProperty({ example: '2026-11-02', description: 'The working day (today or earlier)' })
  @IsDateKey()
  date!: string;

  @ApiProperty({
    example: 30,
    description:
      'Whole minutes to add (negative takes minutes off), never 0, at most 720 either way',
  })
  @Allow()
  minutes!: unknown;

  @ApiProperty({
    example: 'The app crashed from 10:00 to 10:30',
    description: '5 to 300 characters',
  })
  @Allow()
  reason!: unknown;
}

/** GET /focus-adjustments */
export class ListAdjustmentsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional({ example: '2026-11' })
  @IsOptional()
  @IsMonthKey()
  month?: string;

  @ApiPropertyOptional({ description: 'Super Admin or Super Manager: one organisation' })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ default: true, description: 'Undone adjustments too' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeVoided?: boolean;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** GET /focus-adjustments/me */
export class MyAdjustmentsQueryDto {
  @ApiPropertyOptional({ example: '2026-11' })
  @IsOptional()
  @IsMonthKey()
  month?: string;
}
