import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsId } from '@shared/validation/is-id';

export class CreateCompanyDto {
  @ApiProperty({ example: 'lakshmangroup', minLength: 2, maxLength: 80 })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description: 'People with no organisation yet to put into the new one (3.x alias). Optional.',
    type: [String],
    example: ['f6653aad-b393-4b56-9306-08793dfdcaa0'],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsId({ each: true })
  managerIds?: string[];
}
