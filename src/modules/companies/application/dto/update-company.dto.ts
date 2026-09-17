import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCompanyDto {
  @ApiProperty({ example: 'Rhythm RX' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;
}
