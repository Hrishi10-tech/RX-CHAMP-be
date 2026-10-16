import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BREAK_KINDS, BreakKind } from '../../domain/shift.types';
import { IsId } from '@shared/validation/is-id';

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ShiftBreakDto {
  @ApiProperty({ enum: BREAK_KINDS })
  @IsIn(BREAK_KINDS)
  kind!: BreakKind;

  @ApiProperty({ default: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: '11:00' })
  @Matches(HM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @ApiProperty({ example: 15 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  durationMin!: number;

  @ApiProperty({ example: 30, description: 'Minutes before the start the window opens' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  windowBeforeMin!: number;

  @ApiProperty({ example: 60, description: 'Minutes after the start the window closes' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(480)
  windowAfterMin!: number;

  @ApiPropertyOptional({
    description:
      'Whether staff may skip this break (the shift editor toggle). ' +
      'Default: true for MORNING and EVENING, false for LUNCH.',
  })
  @IsOptional()
  @IsBoolean()
  allowSkip?: boolean;
}

export class UpsertShiftDto {
  @ApiProperty({ example: 'General' })
  @IsString()
  @MaxLength(60)
  name!: string;

  @ApiProperty({ example: '09:30' })
  @Matches(HM, { message: 'start must be HH:MM (24h)' })
  start!: string;

  @ApiProperty({ example: '18:30', description: 'Earlier than start = runs past midnight' })
  @Matches(HM, { message: 'end must be HH:MM (24h)' })
  end!: string;

  @ApiProperty({ example: [1, 2, 3, 4, 5], description: 'ISO weekdays, 1 = Monday' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workDays!: number[];

  @ApiPropertyOptional({ description: 'Company the shift belongs to (empty = every company)' })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  ringLeadMin?: number;

  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  ringDurationMin?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  ringSound?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  reasonOnEarly?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  reasonOnLate?: boolean;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  reasonMinChars?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  overrunReason?: boolean;

  @ApiPropertyOptional({
    default: 3,
    description: 'Minutes over a break that are simply break time (no approval)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  overrunGraceMin?: number;

  @ApiProperty({ type: [ShiftBreakDto] })
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ShiftBreakDto)
  breaks!: ShiftBreakDto[];
}
