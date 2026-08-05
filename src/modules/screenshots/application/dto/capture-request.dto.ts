import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CaptureRequestDto {
  @ApiProperty({ description: 'The user whose agent should capture a screenshot now' })
  @IsUUID()
  userId!: string;
}
