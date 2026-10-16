import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { AppSettingsService } from '../application/app-settings.service';
import { PatchSettingsDto } from '../application/dto/patch-settings.dto';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: AppSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Organisation settings (any signed-in role)' })
  async get() {
    return envelope(await this.settings.get());
  }

  @Patch()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Change any subset of the settings (Super Admin); returns the full set',
  })
  async patch(@CurrentUser() me: AuthenticatedUser, @Body() body: PatchSettingsDto) {
    return envelope(await this.settings.update({ ...body }, me.id));
  }
}
