import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class SetMyAvatarDto {
  @ApiProperty({ example: 'M12', description: "A manifest ID from the person's own library." })
  @IsString()
  @MaxLength(32)
  avatarId!: string;
}
