import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsId } from '@shared/validation/is-id';

const SCOPES = ['USERS', 'DEPARTMENTS', 'ORG'] as const;

export class CreateSignOutKeyDto {
  @ApiProperty({ enum: SCOPES, description: 'Who the key lets sign out' })
  @IsIn(SCOPES as unknown as string[], { message: 'scope must be USERS, DEPARTMENTS or ORG' })
  scope!: 'USERS' | 'DEPARTMENTS' | 'ORG';

  @ApiPropertyOptional({ type: [String], description: 'USERS: the people (1..500)' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsId({ each: true, message: 'userIds must hold person ids' })
  userIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'DEPARTMENTS: the departments (1..100)' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsId({ each: true, message: 'departmentIds must hold department ids' })
  departmentIds?: string[];
}

export class UseSignOutKeyDto {
  @ApiProperty({ example: 'amber orbit cedar river lamp 42' })
  @IsString({ message: 'Enter the key your admin gave you.' })
  @MinLength(1, { message: 'Enter the key your admin gave you.' })
  @MaxLength(200)
  key!: string;
}
