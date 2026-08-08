import { ArrayUnique, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCompanyDto {
  @ApiProperty({ example: 'lakshmangroup' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description:
      'User ids (managers) to assign to the new company. Optional — omit to create an unassigned company.',
    type: [String],
    example: ['f6653aad-b393-4b56-9306-08793dfdcaa0'],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  managerIds?: string[];
}
