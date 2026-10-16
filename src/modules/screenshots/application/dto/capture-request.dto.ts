import { ApiProperty } from '@nestjs/swagger';
import { IsId } from '@shared/validation/is-id';

export class CaptureRequestDto {
  @ApiProperty({ description: 'The user whose agent should capture a screenshot now' })
  @IsId()
  userId!: string;
}
