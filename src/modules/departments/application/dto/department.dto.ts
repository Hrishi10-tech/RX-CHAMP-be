import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEPARTMENT_ICONS } from '../../domain/department.rules';

const ICON_MESSAGE = 'Pick an icon from the list.';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Electronics', minLength: 1, maxLength: 60 })
  @IsString({ message: 'Name the department.' })
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ enum: DEPARTMENT_ICONS, default: 'briefcase' })
  @IsOptional()
  @IsIn(DEPARTMENT_ICONS as unknown as string[], { message: ICON_MESSAGE })
  icon?: string;
}

export class UpdateDepartmentDto {
  @ApiPropertyOptional({ example: 'Electronics', minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString({ message: 'Name the department.' })
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: DEPARTMENT_ICONS })
  @IsOptional()
  @IsIn(DEPARTMENT_ICONS as unknown as string[], { message: ICON_MESSAGE })
  icon?: string;
}
