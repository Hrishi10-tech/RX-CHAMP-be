import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsId } from '@shared/validation/is-id';

export class MeetingParticipantDto {
  @ApiPropertyOptional({ description: 'A person picked from /meetings/participants' })
  @IsOptional()
  @IsId()
  id?: string;

  @ApiProperty({ example: 'Asha Rao' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

/** POST /meetings/start */
export class StartMeetingDto {
  @ApiProperty({ example: 'Sprint review', minLength: 1, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  agenda!: string;

  @ApiProperty({ type: [MeetingParticipantDto], maxItems: 30 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MeetingParticipantDto)
  participants: MeetingParticipantDto[] = [];
}

/** POST /meetings/past */
export class LogPastMeetingDto extends StartMeetingDto {
  @ApiProperty({ example: '2026-10-14T05:30:00.000Z' })
  @IsISO8601()
  startedAt!: string;

  @ApiProperty({ minimum: 5, maximum: 480, example: 45 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(480)
  durationMin!: number;
}

/** GET /meetings/participants?q= */
export class ParticipantsQueryDto {
  @ApiPropertyOptional({ description: 'Part of a name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
