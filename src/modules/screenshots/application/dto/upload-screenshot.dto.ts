import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export class UploadScreenshotDto {
  @ApiPropertyOptional({ enum: ['AUTO', 'MANUAL'], default: 'AUTO' })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  kind?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({ description: 'When the shot was captured (defaults to now)' })
  @IsOptional()
  @IsISO8601()
  takenAt?: string;
}
