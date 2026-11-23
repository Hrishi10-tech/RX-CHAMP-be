import { Body, Controller, Delete, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ValidationError } from '@shared/exceptions/app.exception';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { RequireFeature } from '@shared/features/require-feature';
import { RegisterPushTokenDto, RemovePushTokenDto } from '../application/dto/push.dto';
import { PushService } from '../application/push.service';

/**
 * Every phone is forgotten only when nothing was named. An array, or a misspelt field
 * the validation pipe drops, reaches the use case looking the same, so the body as sent
 * is read here.
 */
function assertTokenOrNothing(sent: unknown): void {
  if (sent === undefined || sent === null) return;
  const plain = typeof sent === 'object' && !Array.isArray(sent);
  if (!plain || Object.keys(sent).some((key) => key !== 'token')) {
    throw new ValidationError('Send { token } to forget one phone, or nothing for all of them.');
  }
}

/**
 * The signed-in person's phones for push notifications (any role). Behind the
 * `mobilePush` flag: 404 FEATURE_OFF while it is off, so no token is kept before
 * pushes can go out. A token is never sent back.
 */
@RequireFeature('mobilePush')
@ApiTags('devices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('devices')
export class DevicesController {
  constructor(private readonly push: PushService) {}

  @Post('push-token')
  @HttpCode(201)
  @ApiOperation({ summary: "Register this phone's push token for the signed-in person" })
  async register(@CurrentUser() me: AuthenticatedUser, @Body() body: RegisterPushTokenDto) {
    await this.push.registerDevice(me.id, body.token, body.platform);
    return envelope({ registered: true, platform: body.platform });
  }

  @Delete('push-token')
  @ApiOperation({
    summary: "Forget this phone's push token (in the body), or all of the person's phones",
  })
  async remove(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: RemovePushTokenDto,
    @Req() req: Request,
  ) {
    assertTokenOrNothing(req.body);
    return envelope({ removed: await this.push.removeDevices(me.id, body.token) });
  }
}
