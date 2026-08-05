import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class ArchiveScreenshotsDto {
  @ApiProperty({ description: 'The user whose screenshots are being archived' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: [String], description: 'Screenshot ids to archive' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
