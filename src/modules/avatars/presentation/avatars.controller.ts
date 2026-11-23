import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AvatarCatalog } from '@shared/avatars/avatar-catalog';
import { API_COPY } from '@shared/copy/api-copy';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { Role } from '@shared/rbac/roles.enum';
import { Roles } from '@shared/rbac/roles.decorator';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { RATE_LIMITS, RateLimit } from '@shared/security/rate-limits';
import { ParseIdPipe } from '@shared/validation/is-id';
import { AvatarService } from '../application/avatar.service';
import { SetMyAvatarDto } from '../application/dto/set-my-avatar.dto';

@ApiTags('avatars')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('avatars')
export class AvatarsController {
  constructor(
    private readonly avatars: AvatarService,
    private readonly catalog: AvatarCatalog,
    private readonly config: ConfigService,
  ) {}

  @Get('manifest')
  @ApiOperation({ summary: 'The preset avatar library: defaults and every avatar with its files' })
  manifest() {
    return this.avatars.manifest(this.config.get<string>('apiPrefix') ?? 'api/v1');
  }

  @Get('files/:size/:id.webp')
  @RateLimit(RATE_LIMITS.avatarFiles)
  @ApiOperation({ summary: 'One generated avatar image, cacheable for ever (the URL has a hash)' })
  file(@Param('size') size: string, @Param('id') id: string, @Res() res: Response) {
    const path = this.catalog.webpPath(Number(size), id);
    if (!path) throw new NotFoundError(API_COPY.avatarNotFound);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/webp').sendFile(path, { cacheControl: false });
  }
}

@ApiTags('avatars')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/avatar')
export class MyAvatarController {
  constructor(private readonly avatars: AvatarService) {}

  @Get()
  @ApiOperation({ summary: 'Your avatar: what you show, your choice, your default, your library' })
  mine(@CurrentUser() me: AuthenticatedUser) {
    return this.avatars.mine(me);
  }

  @Put()
  @ApiOperation({
    summary: 'Choose an avatar from your own library (Staff: from the agent or the phone only)',
  })
  choose(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: SetMyAvatarDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.avatars.choose(me, body.avatarId, userAgent);
  }

  @Delete()
  @ApiOperation({ summary: 'Go back to the default avatar (Staff: from the agent or the phone)' })
  reset(@CurrentUser() me: AuthenticatedUser, @Headers('user-agent') userAgent?: string) {
    return this.avatars.resetMine(me, userAgent);
  }
}

@ApiTags('avatars')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users/:id/avatar')
export class UserAvatarController {
  constructor(private readonly avatars: AvatarService) {}

  @Post('reset')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: "Organisation admin or Super Admin: put someone's avatar back on their default",
  })
  reset(@CurrentUser() me: AuthenticatedUser, @Param('id', ParseIdPipe) id: string) {
    return this.avatars.resetFor(me, id);
  }
}
