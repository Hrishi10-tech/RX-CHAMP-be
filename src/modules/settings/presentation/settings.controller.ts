import { Body, Controller, Get, Inject, Patch, Put, UseGuards } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { requireOrg } from '@shared/tenancy';
import { AppSettingsService } from '../application/app-settings.service';
import { PatchSettingsDto } from '../application/dto/patch-settings.dto';
import { PutReasonPresetsDto } from '../application/dto/reason-presets.dto';
import { ReasonPresetsService } from '../application/reason-presets.service';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: AppSettingsService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly presets: ReasonPresetsService,
  ) {}

  @Get('reason-presets')
  @ApiOperation({
    summary:
      'Quick answers offered next to every comment box, one list per kind (any signed-in role)',
  })
  async reasonPresets() {
    return envelope(await this.presets.view());
  }

  @Put('reason-presets')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Replace the presets of the kinds sent (Super Admin); null puts a kind back to its defaults',
  })
  async putReasonPresets(@CurrentUser() me: AuthenticatedUser, @Body() body: PutReasonPresetsDto) {
    return envelope(await this.presets.update(body.presets ?? {}, me.id));
  }

  @Get()
  @ApiOperation({ summary: 'The organisation settings (anyone in the organisation)' })
  async get(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.settings.get(requireOrg(me)));
  }

  @Patch()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Change any subset of the organisation settings (Admin, Super Admin); returns the full set',
  })
  async patch(@CurrentUser() me: AuthenticatedUser, @Body() body: PatchSettingsDto) {
    const companyId = requireOrg(me);
    const saved = await this.settings.update(companyId, { ...body }, me.id);
    await this.events.publish(
      OrgConfigChangedEvent.eventName,
      new OrgConfigChangedEvent(companyId, 'SETTINGS', new Date()),
    );
    return envelope(saved);
  }
}
