import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Body for `POST /presence/heartbeat` — the agent's periodic "I'm online" ping. */
export class HeartbeatDto {
  @ApiPropertyOptional({
    description:
      'True when the machine has been idle past the threshold; closes the online session so idle time is not counted.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  idle?: boolean;
}
