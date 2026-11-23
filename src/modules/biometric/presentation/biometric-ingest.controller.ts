import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationError } from '@shared/exceptions/app.exception';
import { envelope } from '@shared/http/envelope';
import { RATE_LIMITS, RateLimit } from '@shared/security/rate-limits';
import { PushPunchesDto } from '../application/dto/biometric.dto';
import { BiometricIngestService } from '../application/biometric-ingest.service';
import { BiometricKeysService } from '../application/biometric-keys.service';

/**
 * The push API for the biometric system (3.5). No person signs in here: the caller
 * sends an integration key made on the Attendance page. Safe to resend: a punch
 * already stored (same code, time and device) is counted as a duplicate. 4.0: the
 * key says which organisation the punches are for.
 */
@ApiTags('biometric')
@Controller('biometric')
export class BiometricIngestController {
  constructor(
    private readonly keys: BiometricKeysService,
    private readonly ingest: BiometricIngestService,
  ) {}

  @Post('punches')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.biometricPush)
  @ApiHeader({
    name: 'X-Biometric-Key',
    required: true,
    description: 'An integration key (rxb_...)',
  })
  @ApiOperation({
    summary:
      'Send punches (up to 500 a call). Answers what was stored, what was already there, codes nobody has ' +
      'yet, and each punch that was ignored and why. 401 for a missing, unknown or revoked key.',
  })
  async push(
    @Headers('x-biometric-key') key: string | undefined,
    @Ip() ip: string,
    @Body() body: PushPunchesDto,
  ) {
    const now = new Date();
    const found = await this.keys.verify(key, ip ?? null, now);
    if (!Array.isArray(body?.punches)) {
      throw new ValidationError('Send { "punches": [ ... ] }.').withDetails({ field: 'punches' });
    }
    return envelope(
      await this.ingest.ingest(found.companyId, body.punches as never[], 'PUSH', {
        now,
        keyId: found.id,
      }),
    );
  }
}
