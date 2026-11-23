import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { requireOrg } from '@shared/tenancy';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  AttendancePeopleQueryDto,
  CreateKeyDto,
  ImportCsvDto,
  ManualPunchDto,
  PatchBiometricSettingsDto,
  PunchesQueryDto,
  SetAttendanceDto,
  VoidPunchDto,
} from '../application/dto/biometric.dto';
import { BiometricAdminService } from '../application/biometric-admin.service';
import { BiometricKeysService } from '../application/biometric-keys.service';
import { BiometricPullService } from '../application/biometric-pull.service';
import { BiometricSettingsService } from '../application/biometric-settings.service';

/** 4.0: the organisation's admins (a Super Admin acting in it) and the Super Manager read. */
const READERS = [Role.ADMIN, Role.SUPER_ADMIN, Role.SUPER_MANAGER] as const;
/** 4.0: the organisation's admins (a Super Admin acting in it) change. */
const CHANGERS = [Role.ADMIN, Role.SUPER_ADMIN] as const;

/**
 * The Attendance page (3.5): who checks in by the agent and who by biometric, the
 * punch log, punches added or voided by hand, unmatched codes, devices, the
 * integration (keys, pull adapter, CSV import) and its settings. 4.0: everything is
 * the organisation's in view (each runs its own integration); its admins change;
 * the Super Manager reads, and adds or voids punches.
 */
@ApiTags('biometric')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('biometric')
export class BiometricController {
  constructor(
    private readonly admin: BiometricAdminService,
    private readonly keys: BiometricKeysService,
    private readonly settings: BiometricSettingsService,
    private readonly pull: BiometricPullService,
  ) {}

  @Get('status')
  @Roles(...READERS)
  @ApiOperation({
    summary:
      'Integration status: keys, last punch, punches today, unmatched codes, people, the pull',
  })
  async status(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.admin.status(me, new Date()));
  }

  // ---- People -------------------------------------------------------------------

  @Get('people')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Everyone active with how they check in, their biometric ID and their last punch',
  })
  async people(@CurrentUser() me: AuthenticatedUser, @Query() q: AttendancePeopleQueryDto) {
    return envelope(await this.admin.people(me, q));
  }

  @Put('people')
  @Roles(...CHANGERS)
  @ApiOperation({
    summary:
      'Set how people check in (AGENT or BIOMETRIC) and their biometric ID, one or up to 500 at once. A change ' +
      'of source applies from today. 409 BIOMETRIC_CODE_TAKEN',
  })
  async setPeople(@CurrentUser() me: AuthenticatedUser, @Body() body: SetAttendanceDto) {
    return envelope(await this.admin.setPeople(me, body.items as never[], new Date()));
  }

  // ---- Punches ------------------------------------------------------------------

  @Get('punches')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'The punch log, newest first (by day range, person, code, device; unmatched only)',
  })
  async punches(@CurrentUser() me: AuthenticatedUser, @Query() q: PunchesQueryDto) {
    return envelope(await this.admin.punches(me, q));
  }

  @Post('punches/manual')
  @HttpCode(201)
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Add a missing punch by hand, with a reason. 409 MONTH_LOCKED, NO_BIOMETRIC_CODE',
  })
  async addPunch(@CurrentUser() me: AuthenticatedUser, @Body() body: ManualPunchDto) {
    return envelope(await this.admin.addPunch(me, body, new Date()));
  }

  @Post('punches/:id/void')
  @HttpCode(200)
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Void a wrong punch, with a reason (it stays in the log, struck through)',
  })
  async voidPunch(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: VoidPunchDto,
  ) {
    return envelope(await this.admin.voidPunch(me, id, body.reason, new Date()));
  }

  @Post('import')
  @HttpCode(200)
  @Roles(...CHANGERS)
  @ApiOperation({ summary: 'Import punches from CSV text (a header row; up to 2,000 rows a call)' })
  async importCsv(@CurrentUser() me: AuthenticatedUser, @Body() body: ImportCsvDto) {
    return envelope(await this.admin.importCsv(me, body.csv, new Date()));
  }

  @Get('unmatched')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Codes the device sent that nobody has, with how many punches and when',
  })
  async unmatched(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.admin.unmatched(me));
  }

  @Get('devices')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Devices seen, with punches today and when each last sent' })
  async devices(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.admin.devices(me, new Date()));
  }

  // ---- Keys -----------------------------------------------------------------------

  @Get('keys')
  @Roles(...CHANGERS)
  @ApiOperation({ summary: 'Integration keys (never the key itself)' })
  async listKeys(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.keys.list(requireOrg(me)));
  }

  @Post('keys')
  @HttpCode(201)
  @Roles(...CHANGERS)
  @ApiOperation({
    summary: 'Make an integration key. The key is in this answer only: copy it now.',
  })
  async createKey(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateKeyDto) {
    return envelope(await this.keys.create(requireOrg(me), body.name, me.id));
  }

  @Post('keys/:id/revoke')
  @HttpCode(200)
  @Roles(...CHANGERS)
  @ApiOperation({ summary: 'Revoke a key: it stops working at once' })
  async revokeKey(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
  ) {
    return envelope(await this.keys.revoke(requireOrg(me), id, me.id, new Date()));
  }

  // ---- Settings and the pull ---------------------------------------------------------

  @Get('settings')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Biometric settings and the pull adapter (secrets show as set or not)' })
  async getSettings(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.settings.view(requireOrg(me)));
  }

  @Patch('settings')
  @Roles(...CHANGERS)
  @ApiOperation({
    summary:
      'Change the settings: the gap rule (SPAN or PAIRS), a missing check-out (LAST_PUNCH or SHIFT_END), the ' +
      'duplicate window, push direction words, the pull adapter and its secret',
  })
  async patchSettings(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: PatchBiometricSettingsDto,
  ) {
    const companyId = requireOrg(me);
    const { changed } = await this.settings.update(
      companyId,
      body as Record<string, unknown>,
      me.id,
    );
    return envelope({ settings: await this.settings.view(companyId), changed });
  }

  @Post('pull/test')
  @HttpCode(200)
  @Roles(...CHANGERS)
  @ApiOperation({
    summary: 'Read the pull once and show the first rows as understood; nothing is saved',
  })
  async testPull(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.pull.run(requireOrg(me), new Date(), true));
  }

  @Post('pull/run')
  @HttpCode(200)
  @Roles(...CHANGERS)
  @ApiOperation({ summary: 'Pull now (also runs by itself when switched on)' })
  async runPull(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.pull.run(requireOrg(me), new Date(), false));
  }
}
