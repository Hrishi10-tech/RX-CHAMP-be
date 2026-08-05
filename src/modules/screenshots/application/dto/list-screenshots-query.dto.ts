import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ListScreenshotsQueryDto {
  @ApiProperty({ description: 'Whose screenshots to list' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Rows to skip (pagination)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  @ApiPropertyOptional({ description: 'Only screenshots taken at/after this ISO time' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Only screenshots taken strictly before this ISO time (exclusive; window is [from, to))',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: ['AUTO', 'MANUAL'] })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  kind?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({ description: 'Full-text search over OCR-extracted screenshot text' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: false, description: 'Include archived screenshots' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;
}
