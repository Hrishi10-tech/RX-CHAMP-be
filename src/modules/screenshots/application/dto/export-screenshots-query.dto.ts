import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { IsId } from '@shared/validation/is-id';

export class ExportScreenshotsQueryDto {
  @ApiProperty({ description: 'Whose screenshots to export' })
  @IsId()
  userId!: string;

  @ApiPropertyOptional({ description: 'From ISO time' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'To ISO time' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: ['AUTO', 'MANUAL'] })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  kind?: 'AUTO' | 'MANUAL';
}
