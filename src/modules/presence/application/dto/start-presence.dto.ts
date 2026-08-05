import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PresenceKind } from '../../domain/presence-session.repository';

const PRESENCE_KINDS: PresenceKind[] = ['BREAK', 'LUNCH', 'MEETING'];

/** Body for `POST /presence/start` — begin a break / lunch / meeting. */
export class StartPresenceDto {
  @ApiProperty({ enum: PRESENCE_KINDS, description: 'The status to switch into' })
  @IsIn(PRESENCE_KINDS)
  type!: PresenceKind;

  @ApiPropertyOptional({
    description: 'Optional note sent to the manager (typically for MEETING).',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
