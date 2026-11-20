import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/** PUT /settings/reason-presets: { presets: { KIND: string[] | null } } */
export class PutReasonPresetsDto {
  @ApiProperty({
    example: { BREAK_SKIP: ['Client call', 'Deadline'], LATE_DAY_START: null },
    description:
      'Kinds: LATE_DAY_START, BREAK_EARLY, BREAK_LATE, BREAK_SKIP, SKIP_COMMENT, BREAK_OVERRUN, ' +
      'MEETING_AGENDA, DECISION_NOTE. Each list replaces that kind; null restores its defaults.',
  })
  @IsObject()
  presets!: Record<string, unknown>;
}
