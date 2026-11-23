import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { PUSH_PLATFORMS, PushPlatform } from '../../domain/push.types';

const TOKEN_MIN = 20;
/** Real FCM tokens are about 160 to 200 characters; the unique index cannot hold much over 2,600. */
const TOKEN_MAX = 1024;
/** What an FCM token is made of. Anything else (a NUL, a line break) is not one, and Postgres refuses some of it. */
const TOKEN_CHARS = /^[A-Za-z0-9_:-]+$/;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** POST /devices/push-token */
export class RegisterPushTokenDto {
  @ApiProperty({ description: "The phone's FCM registration token" })
  @Transform(trimmed)
  @IsString()
  @Length(TOKEN_MIN, TOKEN_MAX)
  @Matches(TOKEN_CHARS)
  token!: string;

  @ApiProperty({ enum: PUSH_PLATFORMS })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(PUSH_PLATFORMS)
  platform!: PushPlatform;
}

/** DELETE /devices/push-token */
export class RemovePushTokenDto {
  @ApiPropertyOptional({ description: 'Forget this phone; without it, all of your phones' })
  // Not IsOptional, which would also let null through: null is no way to say every phone.
  @ValidateIf((o: RemovePushTokenDto) => o.token !== undefined)
  @Transform(trimmed)
  @IsString()
  @Length(TOKEN_MIN, TOKEN_MAX)
  @Matches(TOKEN_CHARS)
  token?: string;
}
