import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCompanyDto {
  @ApiProperty({ example: 'Rhythm RX', minLength: 2, maxLength: 80 })
  @IsString()
  @MaxLength(200)
  name!: string;
}
