import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MeetingParticipantDto } from './meetings.dto';

/** POST /away (docs/4.0/SPEC.md 2.5, 5.6). Fields per reason are checked by the service (422 AWAY_FIELDS). */
export class SubmitAwayDto {
  @ApiProperty({
    description: 'When input stopped (the away start)',
    example: '2026-10-20T08:35:00.000Z',
  })
  @IsISO8601()
  startedAt!: string;

  @ApiProperty({ example: 'THINKING', description: 'A key from config.idle.reasons' })
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9_-]+$/)
  reasonKey!: string;

  @ApiPropertyOptional({
    description: 'The one line (thinking, hardware, other work, meeting summary): 3..200',
  })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  comment?: string;

  @ApiPropertyOptional({
    type: [MeetingParticipantDto],
    description: 'Short meeting: 1..30 people',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => MeetingParticipantDto)
  participants?: MeetingParticipantDto[];

  @ApiPropertyOptional({ description: 'Short meeting: who will mail the minutes (2..80)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  momSender?: string;
}

/** POST /away/unexplained: the pop-up was never answered (End Day, shutdown). */
export class UnexplainedAwayDto {
  @ApiProperty()
  @IsISO8601()
  startedAt!: string;

  @ApiProperty()
  @IsISO8601()
  endedAt!: string;
}
