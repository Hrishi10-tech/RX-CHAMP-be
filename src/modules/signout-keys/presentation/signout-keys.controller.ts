import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import { SignOutKeysService } from '../application/signout-keys.service';
import { CreateSignOutKeyDto, UseSignOutKeyDto } from '../application/dto/signout-key.dto';

/** Sign-out keys of the organisation (docs/4.0/SPEC.md 2.8, 5.5). Admin, Super Admin. */
@ApiTags('signout-keys')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@Controller('signout-keys')
export class SignOutKeysController {
  constructor(private readonly keys: SignOutKeysService) {}

  @Get()
  @ApiOperation({
    summary: 'Keys issued in the last 30 days, with scope, uses and whether still active',
  })
  async list(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.keys.list(me));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Issue a 24-hour key for people, departments or the organisation; the phrase is shown only here',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateSignOutKeyDto) {
    return envelope(
      await this.keys.create(me, {
        scope: body.scope,
        userIds: body.userIds,
        departmentIds: body.departmentIds,
      }),
    );
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a key at once' })
  async revoke(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.keys.revoke(me, id));
  }
}

/** The agent's key-gated sign-out and quit (docs/4.0/SPEC.md 5.6). */
@ApiTags('agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agent')
export class AgentSignOutController {
  constructor(private readonly keys: SignOutKeysService) {}

  @Post('sign-out')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Sign this person's agent out with a key: ends their agent sessions and invalidates old installers. " +
      '403 SIGNOUT_KEY_INVALID; 429 after 5 wrong keys in 10 minutes.',
  })
  async signOut(@CurrentUser() me: AuthenticatedUser, @Body() body: UseSignOutKeyDto) {
    return envelope(await this.keys.signOut(me, body.key));
  }

  @Post('quit-check')
  @HttpCode(200)
  @ApiOperation({
    summary: "Check a key before an Admin's or Super Admin's agent quits (same rules, no sign-out)",
  })
  async quitCheck(@CurrentUser() me: AuthenticatedUser, @Body() body: UseSignOutKeyDto) {
    return envelope(await this.keys.quitCheck(me, body.key));
  }
}
