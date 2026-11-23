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
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { isAdminLike, orgOf, requireOrg } from '@shared/tenancy';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  ListWfhQueryDto,
  ListWfhSchedulesQueryDto,
  PatchWfhPolicyDto,
  WfhDecisionDto,
  WfhRequestDto,
  WfhScheduleDto,
  WfhScheduleSkipDto,
  WfhScheduleUpdateDto,
  WfhSummaryQueryDto,
} from '../application/dto/wfh.dto';
import { WfhOverviewService } from '../application/wfh-overview.service';
import { WfhPolicyService } from '../application/wfh-policy.service';
import { WfhRequestsService } from '../application/wfh-requests.service';
import { WfhSchedulesService } from '../application/wfh-schedules.service';

const OVERSEERS = [Role.MANAGER, Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN] as const;

/**
 * Work from home (3.5). Everyone: ask for their own, see their requests and
 * schedules. Approvers: the requests in their scope. Department managers, the
 * organisation admin and above: schedules for the people they see. The policy
 * (4.0): each organisation's own, changed by its admins.
 */
@ApiTags('wfh')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('wfh')
export class WfhController {
  constructor(
    private readonly policies: WfhPolicyService,
    private readonly requests: WfhRequestsService,
    private readonly schedules: WfhSchedulesService,
    private readonly overview: WfhOverviewService,
  ) {}

  // ---- Everyone -------------------------------------------------------------

  @Get('policy')
  @ApiOperation({
    summary: 'The work-from-home policy (any role), with what the caller may change',
  })
  async policy(@CurrentUser() me: AuthenticatedUser) {
    return envelope(
      WfhPolicyService.view(await this.policies.get(orgOf(me)), {
        canEdit: isAdminLike(me) && !!orgOf(me),
        canRoute: isAdminLike(me) && !!orgOf(me),
      }),
    );
  }

  @Get('me')
  @ApiOperation({
    summary:
      'My work from home (any role): today, this month, requests, schedules, who approves, the policy',
  })
  async me(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.overview.my(me, new Date()));
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'What a request would cover, who decides it, and what stops it, without making it',
  })
  async preview(@CurrentUser() me: AuthenticatedUser, @Body() body: WfhRequestDto) {
    return envelope(await this.requests.preview(me, body, new Date()));
  }

  @Post('requests')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Ask to work from home (any role, for yourself). 400 for the request itself (details.field); 409 ' +
      'WFH_OFF, WFH_OVERLAP, WFH_SCHEDULED, LEAVE_OVERLAP, WFH_MONTH_CAP or MONTH_LOCKED',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: WfhRequestDto) {
    return envelope(await this.requests.create(me, body, new Date()));
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel your own request: waiting, or approved and not yet begun' })
  async cancel(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.requests.cancel(me, id, new Date()));
  }

  // ---- Approvers ------------------------------------------------------------

  @Get('requests/summary')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary: 'Waiting requests in scope, and how many wait on the caller (the badge)',
  })
  async summary(@CurrentUser() me: AuthenticatedUser, @Query() q: WfhSummaryQueryDto) {
    return envelope(await this.requests.summary(me, q));
  }

  @Get('requests')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Requests in scope (Manager: own team; Super Manager, Super Admin: everyone, one organisation or ' +
      "one manager's team), waiting first",
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: ListWfhQueryDto) {
    return envelope(await this.requests.list(me, q, new Date()));
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One request: your own, or one in your scope' })
  async get(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.requests.get(me, id, new Date()));
  }

  @Post('requests/:id/approve')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary: 'Approve (the reporting manager, the Super Manager for a Manager, a Super Admin)',
  })
  async approve(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: WfhDecisionDto,
  ) {
    return envelope(await this.requests.decide(me, id, true, body.note, new Date()));
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Reject, with a note for the person' })
  async reject(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: WfhDecisionDto,
  ) {
    return envelope(await this.requests.decide(me, id, false, body.note, new Date()));
  }

  @Post('requests/:id/revoke')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Take back approved work from home, with a note (outside locked months). Hours already worked from ' +
      'home on the phone then no longer count.',
  })
  async revoke(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: WfhDecisionDto,
  ) {
    return envelope(await this.requests.revoke(me, id, body.note, new Date()));
  }

  // ---- Schedules ------------------------------------------------------------

  @Get('schedules')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary: 'Work-from-home schedules in scope (running and ahead; ended ones on request)',
  })
  async listSchedules(@CurrentUser() me: AuthenticatedUser, @Query() q: ListWfhSchedulesQueryDto) {
    return envelope(await this.schedules.list(me, q, new Date()));
  }

  @Post('schedules')
  @HttpCode(201)
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Set a schedule for someone (their Manager, the Super Manager, a Super Admin): weekdays, some weeks ' +
      'of the month if wanted, full, half or quarter day, from a date. 409 WFH_SCHEDULE_OVERLAP',
  })
  async createSchedule(@CurrentUser() me: AuthenticatedUser, @Body() body: WfhScheduleDto) {
    return envelope(await this.schedules.create(me, body, new Date()));
  }

  @Put('schedules/:id')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Change a schedule. One that has begun ends and a new one starts from today (tomorrow when today ' +
      'was already on it), so past days keep what they were',
  })
  async updateSchedule(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: WfhScheduleUpdateDto,
  ) {
    return envelope(await this.schedules.update(me, id, body, new Date()));
  }

  @Post('schedules/:id/end')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'End a schedule after today (one not begun yet is removed)' })
  async endSchedule(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
  ) {
    return envelope(await this.schedules.end(me, id, new Date()));
  }

  @Post('schedules/:id/skip')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Leave one day out of a schedule (skip: false puts it back)' })
  async skipDay(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: WfhScheduleSkipDto,
  ) {
    return envelope(await this.schedules.skip(me, id, body.date, body.skip !== false, new Date()));
  }

  // ---- Policy ---------------------------------------------------------------

  @Patch('policy')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: "Change the organisation's work-from-home policy (its admins, who approves included)",
  })
  async patchPolicy(@CurrentUser() me: AuthenticatedUser, @Body() body: PatchWfhPolicyDto) {
    // 4.0: the organisation's admins change their organisation's policy.
    if (!isAdminLike(me)) {
      throw new ForbiddenError('Only the organisation admin can change the work-from-home policy.');
    }
    const { after, changed } = await this.policies.update(
      requireOrg(me),
      body as Record<string, unknown>,
      { mayRoute: true, updatedById: me.id },
    );
    return envelope({
      policy: WfhPolicyService.view(after, { canEdit: true, canRoute: true }),
      changed,
    });
  }
}
