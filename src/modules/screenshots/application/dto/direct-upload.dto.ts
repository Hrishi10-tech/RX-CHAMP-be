import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /screenshots/upload-url: ask for a presigned link for one shot. */
export class RequestUploadUrlDto {
  @ApiPropertyOptional({ enum: ['image/jpeg', 'image/png'], default: 'image/jpeg' })
  @IsOptional()
  @IsIn(['image/jpeg', 'image/png'])
  contentType?: 'image/jpeg' | 'image/png';

  @ApiPropertyOptional({ enum: ['AUTO', 'MANUAL'], default: 'AUTO' })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  kind?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({ description: 'When the shot was captured (defaults to now)' })
  @IsOptional()
  @IsISO8601()
  takenAt?: string;
}

/** POST /screenshots/complete: the shot is in S3 under `key`; record it. */
export class CompleteUploadDto {
  @ApiProperty({ description: 'The key returned by POST /screenshots/upload-url' })
  @IsString()
  @MaxLength(512)
  key!: string;

  @ApiPropertyOptional({ enum: ['AUTO', 'MANUAL'], default: 'AUTO' })
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  kind?: 'AUTO' | 'MANUAL';

  @ApiPropertyOptional({ description: 'When the shot was captured (defaults to now)' })
  @IsOptional()
  @IsISO8601()
  takenAt?: string;
}
