import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Body for `POST /auth/enroll` — the per-user token baked into an agent download. */
export class EnrollDto {
  @ApiProperty({ description: 'The enrollment token embedded in the downloaded agent.' })
  @IsString()
  @MinLength(1)
  token!: string;
}
