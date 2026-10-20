import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { envelope } from '@shared/http/envelope';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { appTimezone } from '@shared/utils/timezone';
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  MonthQueryDto,
  ParseMonthPipe,
  PersonDayQueryDto,
  TeamDayQueryDto,
  TeamMonthQueryDto,
  TimesheetQueryDto,
} from '../application/dto/reports.dto';
import { MonthLockService } from '../application/month-lock.service';
import {
  exportFileName,
  payrollWorkbook,
  timesheetFileName,
  timesheetWorkbook,
} from '../application/report-export';
import { ReportRunsService } from '../application/report-runs.service';
import { ReportsService } from '../application/reports.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendWorkbook(res: Response, body: Buffer, fileName: string): void {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * Reports (SPEC 1.9, 3.7). Managers see their direct reports, Super Admins
 * everyone. A locked month is read from its snapshot.
 */
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly locks: MonthLockService,
    private readonly runs: ReportRunsService,
  ) {}

  @Get('people')
  @ApiOperation({ summary: 'The people the caller may report on' })
  async people(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.reports.people(me, new Date()));
  }

  @Get('person/:userId/day')
  @ApiOperation({
    summary: "One person's day: summary, timeline, skips, breaks, meetings, approvals, hourly",
  })
  async personDay(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', ParseIdPipe) userId: string,
    @Query() q: PersonDayQueryDto,
  ) {
    return envelope(await this.reports.personDay(me, userId, q.date, new Date()));
  }

  @Get('person/:userId/month')
  @ApiOperation({ summary: "One person's month: totals, each day and the hourly heatmap" })
  async personMonth(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', ParseIdPipe) userId: string,
    @Query() q: MonthQueryDto,
  ) {
    const now = new Date();
    return envelope(
      await this.reports.personMonth(me, userId, this.reports.monthOrCurrent(q.month, now), now),
    );
  }

  @Get('person/:userId/month/export.xlsx')
  @ApiProduces(XLSX)
  @ApiOperation({ summary: "One person's month as an Excel workbook (sheets Payroll and Days)" })
  async exportPersonMonth(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', ParseIdPipe) userId: string,
    @Query() q: MonthQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const now = new Date();
    const month = this.reports.monthOrCurrent(q.month, now);
    const report = await this.reports.personMonth(me, userId, month, now);
    const file = await payrollWorkbook([report], appTimezone());
    sendWorkbook(res, file, exportFileName(month, report.person.name));
  }

  @Get('person/:userId/timesheet')
  @ApiOperation({
    summary:
      "4.0: one person's timesheet for a range (at most 366 days): in and out, focus against target, " +
      'paid and unpaid breaks, meetings, away time, the day class, and totals',
  })
  async timesheet(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', ParseIdPipe) userId: string,
    @Query() q: TimesheetQueryDto,
  ) {
    return envelope(await this.reports.timesheet(me, userId, q.from, q.to, new Date()));
  }

  @Get('person/:userId/timesheet.xlsx')
  @ApiProduces(XLSX)
  @ApiOperation({ summary: '4.0: the same timesheet as an Excel workbook' })
  async timesheetXlsx(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', ParseIdPipe) userId: string,
    @Query() q: TimesheetQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const t = await this.reports.timesheet(me, userId, q.from, q.to, new Date());
    sendWorkbook(res, await timesheetWorkbook(t), timesheetFileName(t.person.name, q.from, q.to));
  }

  @Get('team/day')
  @ApiOperation({ summary: 'Everyone in scope (or userIds) for one day' })
  async teamDay(@CurrentUser() me: AuthenticatedUser, @Query() q: TeamDayQueryDto) {
    return envelope(await this.reports.teamDay(me, q.date, q.userIds, new Date(), q.departmentId));
  }

  @Get('team/month')
  @ApiOperation({ summary: 'Team month: totals and one row per person with each day' })
  async teamMonth(@CurrentUser() me: AuthenticatedUser, @Query() q: TeamMonthQueryDto) {
    const now = new Date();
    return envelope(
      await this.reports.teamMonth(
        me,
        this.reports.monthOrCurrent(q.month, now),
        q.managerId,
        q.userIds,
        now,
        q.departmentId,
      ),
    );
  }

  @Get('team/month/export.xlsx')
  @ApiProduces(XLSX)
  @ApiOperation({
    summary: 'Team month as an Excel workbook for payroll (sheets Payroll and Days)',
  })
  async exportTeamMonth(
    @CurrentUser() me: AuthenticatedUser,
    @Query() q: TeamMonthQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const now = new Date();
    const month = this.reports.monthOrCurrent(q.month, now);
    const { persons } = await this.reports.teamMonthWithPersons(
      me,
      month,
      q.managerId,
      q.userIds,
      now,
      q.departmentId,
    );
    const file = await payrollWorkbook(persons, appTimezone());
    sendWorkbook(res, file, exportFileName(month, 'team'));
  }

  @Get('runs')
  @ApiOperation({ summary: 'My monthly report runs, newest month first' })
  async listRuns(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.runs.list(me));
  }

  @Get('months/:month/lock')
  @ApiOperation({ summary: 'Whether a month is locked, by whom, and how many items still wait' })
  async lockStatus(
    @CurrentUser() me: AuthenticatedUser,
    @Param('month', ParseMonthPipe) month: string,
  ) {
    return envelope(await this.locks.status(me, month, new Date()));
  }

  @Post('months/:month/lock')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Lock a month for payroll (409 PENDING_APPROVALS while anything dated in it is pending)',
  })
  async lock(@CurrentUser() me: AuthenticatedUser, @Param('month', ParseMonthPipe) month: string) {
    return envelope(await this.locks.lock(me, month, new Date()));
  }

  @Delete('months/:month/lock')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Unlock a month' })
  async unlock(
    @CurrentUser() me: AuthenticatedUser,
    @Param('month', ParseMonthPipe) month: string,
  ) {
    return envelope(await this.locks.unlock(me, month, new Date()));
  }
}
