import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';
import { IsId } from '@shared/validation/is-id';

export class ArchiveScreenshotsDto {
  @ApiProperty({ description: 'The user whose screenshots are being archived' })
  @IsId()
  userId!: string;

  @ApiProperty({ type: [String], description: 'Screenshot ids to archive' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsId({ each: true })
  ids!: string[];
}
