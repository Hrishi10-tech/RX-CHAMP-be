import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  ClaimCompOffDto,
  CompOffSummaryQueryDto,
  DecideCompOffDto,
  GrantCompOffDto,
  ListCompOffQueryDto,
} from '../application/dto/compoff.dto';
import { CompOffService } from '../application/compoff.service';

const OVERSEERS = [Role.MANAGER, Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN] as const;

/**
 * Comp off (3.5). Everyone: their extra days, claims and credits. Approvers: the
 * claims in their scope. Managers (their departments), the organisation admin and
 * the platform roles (the organisation in view): comp off credited by hand. Taking comp off is POST /leave/requests with
 * category COMPOFF.
 */
@ApiTags('comp-off')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('leave/comp-off')
export class CompOffController {
  constructor(private readonly compOff: CompOffService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'My comp off (any role): what can be taken, extra days worked with what each earns, claims and credits, ' +
      'who approves, the rules',
  })
  async me(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.compOff.my(me, new Date()));
  }

  @Post('claims')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Claim comp off for an extra day worked. 409 COMPOFF_OFF, NOT_AN_EXTRA_DAY, NOT_CLAIMABLE, ' +
      'ALREADY_CLAIMED, NOT_ENOUGH_WORKED, COMPOFF_CAP',
  })
  async claim(@CurrentUser() me: AuthenticatedUser, @Body() body: ClaimCompOffDto) {
    return envelope(await this.compOff.claim(me, body, new Date()));
  }

  @Post('claims/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel your own claim while it waits' })
  async cancel(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.compOff.cancel(me, id, new Date()));
  }

  @Get('claims/summary')
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Claims waiting in scope, and how many wait on the caller (the badge)' })
  async summary(@CurrentUser() me: AuthenticatedUser, @Query() q: CompOffSummaryQueryDto) {
    return envelope(await this.compOff.summary(me, q));
  }

  @Get('claims')
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Claims and credits in scope, waiting first' })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: ListCompOffQueryDto) {
    return envelope(await this.compOff.list(me, q, new Date()));
  }

  @Post('claims/:id/approve')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Approve a claim as asked, or a half day instead of a full one' })
  async approve(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: DecideCompOffDto,
  ) {
    return envelope(await this.compOff.decide(me, id, true, body, new Date()));
  }

  @Post('claims/:id/reject')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Reject a claim, with a note for the person' })
  async reject(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: DecideCompOffDto,
  ) {
    return envelope(await this.compOff.decide(me, id, false, body, new Date()));
  }

  @Post('claims/:id/revoke')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Take back an approved credit no comp off leave needs, with a note. 409 COMPOFF_IN_USE',
  })
  async revoke(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: DecideCompOffDto,
  ) {
    return envelope(await this.compOff.revoke(me, id, body.note, new Date()));
  }

  @Post('grants')
  @HttpCode(201)
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Credit comp off by hand (work that was not tracked): a Manager for the Staff of their ' +
      'departments, the organisation admin for their organisation',
  })
  async grant(@CurrentUser() me: AuthenticatedUser, @Body() body: GrantCompOffDto) {
    return envelope(await this.compOff.grant(me, body, new Date()));
  }

  @Get('people/:userId')
  @ApiOperation({ summary: "One person's comp off: yourself, or someone in your scope" })
  async person(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', new ParseIdPipe()) userId: string,
  ) {
    return envelope(await this.compOff.personView(me, userId, new Date()));
  }
}
