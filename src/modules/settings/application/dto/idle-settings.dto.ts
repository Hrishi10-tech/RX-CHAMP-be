import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IDLE_MINUTES,
  MAX_CUSTOM_REASONS,
  MAX_DEPARTMENT_REASON_KEYS,
} from '../../domain/idle.rules';

const KEY = /^[A-Za-z0-9_-]{1,50}$/;

export class IdleReasonDto {
  @ApiPropertyOptional({
    example: 'THINKING',
    nullable: true,
    description:
      'Key of an existing reason; a new custom reason may bring its own CUSTOM_<SLUG> key, or omit it (the server makes C_<SLUG>).',
  })
  @IsOptional()
  @IsString()
  @Matches(KEY, { message: 'key is not a reason key' })
  key?: string | null;

  @ApiProperty({ example: 'Thinking', minLength: 2, maxLength: 40 })
  @IsString()
  @MaxLength(80)
  label!: string;

  @ApiPropertyOptional({ description: 'Ignored: the kind follows the key (built-in or CUSTOM).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;
}

export class PutIdleSettingsDto {
  @ApiProperty({ example: false, description: 'Input tracking on for everyone by default' })
  @IsBoolean({ message: 'defaultEnabled must be true or false' })
  defaultEnabled!: boolean;

  @ApiProperty({ example: 5, minimum: IDLE_MINUTES.min, maximum: IDLE_MINUTES.max })
  @IsInt({ message: 'defaultMinutes must be a whole number' })
  @Min(IDLE_MINUTES.min)
  @Max(IDLE_MINUTES.max)
  defaultMinutes!: number;

  @ApiPropertyOptional({
    type: [IdleReasonDto],
    description:
      'The full reasons list: every built-in (renamable) plus custom reasons. Omit to keep the list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CUSTOM_REASONS + 10)
  @ValidateNested({ each: true })
  @Type(() => IdleReasonDto)
  reasons?: IdleReasonDto[];
}

export class PutDepartmentIdleDto {
  @ApiPropertyOptional({ nullable: true, description: 'null = organisation default' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsBoolean({ message: 'enabled must be true, false or null' })
  enabled?: boolean | null;

  @ApiPropertyOptional({ nullable: true, minimum: IDLE_MINUTES.min, maximum: IDLE_MINUTES.max })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt({ message: 'minutes must be a whole number or null' })
  @Min(IDLE_MINUTES.min)
  @Max(IDLE_MINUTES.max)
  minutes?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: [String],
    description: 'Reason keys offered in this department; null = the default set',
  })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_DEPARTMENT_REASON_KEYS)
  @IsString({ each: true })
  @Matches(KEY, { each: true, message: 'reasonKeys must hold reason keys' })
  reasonKeys?: string[] | null;
}
