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
import { MonthParamDto, ScreenshotReportDto } from '../application/dto';
import { ScreenshotExportService } from '../application/screenshot-export.service';

/**
 * Screenshot reports, monthly archives and monthly deletion (3.2). Each is a job:
 * start it, poll it while the progress window is open (closing the window
 * cancels it), then download the file.
 */
@ApiTags('screenshots')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// 4.0: the service checks the organisation, departments and grants.
@Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN, Role.SUPER_MANAGER)
@Controller('screenshots')
export class ScreenshotExportsController {
  constructor(private readonly exports: ScreenshotExportService) {}

  @Post('exports/estimate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'How many screenshots a report would hold, roughly how long and how big',
  })
  async estimate(@CurrentUser() me: AuthenticatedUser, @Body() body: ScreenshotReportDto) {
    return envelope(await this.exports.estimateReport(me, body, new Date()));
  }

  @Post('exports/report')
  @HttpCode(202)
  @ApiOperation({
    summary:
      "Start one person's screenshot report (PDF): a day, days, a month or a time window " +
      '(Manager: own team; Super Admin: anyone)',
  })
  async report(@CurrentUser() me: AuthenticatedUser, @Body() body: ScreenshotReportDto) {
    return envelope(await this.exports.startReport(me, body, new Date()));
  }

  @Get('exports')
  @ApiOperation({ summary: 'Your recent screenshot exports' })
  async recent(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.exports.recent(me, new Date()));
  }

  @Get('exports/:id')
  @ApiOperation({
    summary:
      'An export and its progress (fraction, time left). Poll it while the progress window is ' +
      'open: an export nobody polls for 45 seconds is cancelled.',
  })
  async get(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.exports.view(me, id, new Date()));
  }

  @Post('exports/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an export (the progress window was closed)' })
  async cancel(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.exports.cancel(me, id, new Date()));
  }

  @Get('exports/:id/download')
  @ApiOperation({ summary: 'A short-lived link to the finished file' })
  async download(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.exports.download(me, id, new Date()));
  }

  @Get('archives')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Months with screenshots: their archive, whether they can be deleted, and by when (Super Admin)',
  })
  async months(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.exports.months(me, new Date()));
  }

  @Get('archives/nudge')
  @ApiOperation({
    summary:
      'The month to archive and delete next, for the reminder in the portal (Super Admin; else null)',
  })
  async nudge(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.exports.nudge(me, new Date()));
  }

  @Post('archives/:month/archive')
  @HttpCode(202)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Start the archive of a month: a zip of Month/Department/Employee/<day>.pdf (Super Admin). ' +
      'Any time; only one made after the month ended allows deleting it.',
  })
  async archive(@CurrentUser() me: AuthenticatedUser, @Param() p: MonthParamDto) {
    return envelope(await this.exports.startArchive(me, p.month, new Date()));
  }

  @Post('archives/:month/delete')
  @HttpCode(202)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "Delete a month's screenshots (Super Admin): after the month ended, and only once a complete " +
      'archive made after it ended has been downloaded. Deletes only what that archive holds.',
  })
  async purge(@CurrentUser() me: AuthenticatedUser, @Param() p: MonthParamDto) {
    return envelope(await this.exports.startPurge(me, p.month, new Date()));
  }
}
