import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsId } from '@shared/validation/is-id';

export class SendMessageDto {
  @ApiProperty({ description: 'Recipient user id' })
  @IsId()
  toUserId!: string;

  @ApiProperty({ description: 'Message text', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
