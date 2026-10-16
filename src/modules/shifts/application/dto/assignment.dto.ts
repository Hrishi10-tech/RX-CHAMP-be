import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsId } from '@shared/validation/is-id';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class AssignDepartmentDto {
  @ApiProperty({ example: 'Support' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  department!: string;

  @ApiPropertyOptional({ description: 'Limit to one company (empty = every company)' })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiProperty({ nullable: true, description: 'null = no department shift (use the default)' })
  @ValidateIf((_o, v) => v !== null)
  @IsId()
  shiftId!: string | null;

  @ApiProperty({
    example: '2026-10-14',
    description: 'First local day it applies (today or later)',
  })
  @Matches(DATE_KEY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;
}

export class AssignPeopleDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsId({ each: true })
  userIds!: string[];

  @ApiProperty({ nullable: true, description: "null = back to the department's shift" })
  @ValidateIf((_o, v) => v !== null)
  @IsId()
  shiftId!: string | null;

  @ApiProperty({ example: '2026-10-14' })
  @Matches(DATE_KEY, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Last day (optional)' })
  @IsOptional()
  @Matches(DATE_KEY, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string;
}

export class ListPeopleShiftsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
