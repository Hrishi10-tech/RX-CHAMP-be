import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { requireOrg } from '@shared/tenancy';
import { ParseIdPipe } from '@shared/validation/is-id';
import { IdleSettingsService } from '../application/idle-settings.service';
import { PutDepartmentIdleDto, PutIdleSettingsDto } from '../application/dto/idle-settings.dto';

/** Input (away) tracking settings of the organisation (docs/4.0/SPEC.md 2.5, 5.5). */
@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@Controller('idle-settings')
export class IdleSettingsController {
  constructor(private readonly idle: IdleSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Input tracking defaults, away reasons and per-department overrides (Admin, Super Admin)',
  })
  async get(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.idle.get(requireOrg(me)));
  }

  @Put()
  @ApiOperation({
    summary:
      'Set the organisation default and the reasons list (built-ins can be renamed, not removed)',
  })
  async put(@CurrentUser() me: AuthenticatedUser, @Body() body: PutIdleSettingsDto) {
    return envelope(
      await this.idle.update(
        requireOrg(me),
        {
          defaultEnabled: body.defaultEnabled,
          defaultMinutes: body.defaultMinutes,
          reasons: body.reasons?.map((r) => ({ key: r.key ?? null, label: r.label })),
        },
        me.id,
      ),
    );
  }

  @Put('departments/:id')
  @ApiOperation({
    summary: "Set one department's override (each field null = organisation default)",
  })
  async putDepartment(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: PutDepartmentIdleDto,
  ) {
    return envelope(
      await this.idle.updateDepartment(
        requireOrg(me),
        id,
        {
          enabled: body.enabled ?? null,
          minutes: body.minutes ?? null,
          reasonKeys: body.reasonKeys ?? null,
        },
        me.id,
      ),
    );
  }
}
