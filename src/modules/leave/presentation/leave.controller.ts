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
  AdjustLeaveDto,
  AdjustmentsQueryDto,
  BalancesQueryDto,
  LeaveDecisionDto,
  LeavePreviewDto,
  LeaveRequestDto,
  LeaveSummaryQueryDto,
  ListLeaveQueryDto,
  MyLeaveQueryDto,
  PatchLeavePolicyDto,
  SetQuotaDto,
} from '../application/dto/leave.dto';
import { LeaveAccountsService } from '../application/leave-accounts.service';
import { LeaveOverviewService } from '../application/leave-overview.service';
import { LeavePolicyService } from '../application/leave-policy.service';
import { LeaveRequestsService } from '../application/leave-requests.service';

// 4.0: the organisation's Admin too.
const OVERSEERS = [Role.MANAGER, Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN] as const;

/**
 * Leave (3.4). Everyone: their own balances, requests and the policy. Approvers:
 * the requests in their scope. The Super Manager and Super Admins: balances,
 * quotas, adjustments and the policy (who approves is the Super Admin's).
 */
@ApiTags('leave')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly policies: LeavePolicyService,
    private readonly requests: LeaveRequestsService,
    private readonly accounts: LeaveAccountsService,
    private readonly overview: LeaveOverviewService,
  ) {}

  // ---- Everyone -------------------------------------------------------------

  @Get('policy')
  @ApiOperation({ summary: 'The leave policy (any role), with what the caller may change' })
  async policy(@CurrentUser() me: AuthenticatedUser) {
    const now = new Date();
    return envelope(
      LeavePolicyService.view(await this.policies.get(orgOf(me), now), {
        canEdit: isAdminLike(me) && !!orgOf(me),
        canRoute: isAdminLike(me) && !!orgOf(me),
        now,
      }),
    );
  }

  @Get('me')
  @ApiOperation({
    summary:
      'My leave (any role): balances of both pools, next year from December, upcoming leave, requests, ' +
      'the ledger, who approves, and the policy',
  })
  async me(@CurrentUser() me: AuthenticatedUser, @Query() q: MyLeaveQueryDto) {
    return envelope(await this.overview.my(me, q.year, new Date()));
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'What a request would charge and leave, and what stops it, without making it',
  })
  async preview(@CurrentUser() me: AuthenticatedUser, @Body() body: LeavePreviewDto) {
    return envelope(await this.requests.preview(me, body, new Date()));
  }

  @Post('requests')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Apply for leave (any role, for yourself). 400 for the request itself (details.field), 409 ' +
      'LEAVE_OFF, LEAVE_OVERLAP, NOT_ENOUGH_LEAVE or MONTH_LOCKED',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: LeaveRequestDto) {
    return envelope(await this.requests.create(me, body, new Date()));
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel your own request: pending, or approved and not yet begun' })
  async cancel(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.requests.cancel(me, id, new Date()));
  }

  // ---- Approvers ------------------------------------------------------------

  @Get('requests/summary')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary: 'Pending requests in scope, and how many wait on the caller (the badge)',
  })
  async summary(@CurrentUser() me: AuthenticatedUser, @Query() q: LeaveSummaryQueryDto) {
    return envelope(await this.requests.summary(me, q));
  }

  @Get('requests')
  @Roles(...OVERSEERS)
  @ApiOperation({
    summary:
      'Requests in scope (Manager: own team; Super Manager, Super Admin: everyone, one organisation or ' +
      "one manager's team), pending first",
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: ListLeaveQueryDto) {
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
    summary: 'Approve (the approver on its route, the Super Manager for a Manager, a Super Admin)',
  })
  async approve(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: LeaveDecisionDto,
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
    @Body() body: LeaveDecisionDto,
  ) {
    return envelope(await this.requests.decide(me, id, false, body.note, new Date()));
  }

  @Post('requests/:id/revoke')
  @HttpCode(200)
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Take back approved leave, with a note (outside locked months)' })
  async revoke(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: LeaveDecisionDto,
  ) {
    return envelope(await this.requests.revoke(me, id, body.note, new Date()));
  }

  // ---- Balances -------------------------------------------------------------

  @Get('balances')
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'Both pools of everyone in scope for one year' })
  async balances(@CurrentUser() me: AuthenticatedUser, @Query() q: BalancesQueryDto) {
    return envelope(await this.overview.balances(me, q, new Date()));
  }

  @Get('balances/:userId')
  @ApiOperation({
    summary: "One person's leave: balances, quota, ledger, requests (yourself or someone in scope)",
  })
  async person(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', new ParseIdPipe()) userId: string,
    @Query() q: MyLeaveQueryDto,
  ) {
    return envelope(await this.overview.person(me, userId, q.year, new Date()));
  }

  @Put('quotas/:userId')
  @Roles(Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: "Set a person's own yearly days of a pool (null: the policy's); this year follows",
  })
  async quota(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', new ParseIdPipe()) userId: string,
    @Body() body: SetQuotaDto,
  ) {
    const now = new Date();
    await this.accounts.setQuota(me, userId, body, now);
    return envelope(await this.overview.person(me, userId, undefined, now));
  }

  @Post('adjustments')
  @HttpCode(201)
  @Roles(Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Add days to, take days off, or set a balance, with a reason the person reads',
  })
  async adjust(@CurrentUser() me: AuthenticatedUser, @Body() body: AdjustLeaveDto) {
    const now = new Date();
    const saved = await this.accounts.adjust(me, body, now);
    const [view] = await this.accounts.adjustmentViews([saved]);
    return envelope({
      adjustment: view,
      person: await this.overview.person(me, body.userId, saved.year, now),
    });
  }

  @Get('adjustments')
  @Roles(...OVERSEERS)
  @ApiOperation({ summary: 'The adjustment trail, newest first (Manager: own team)' })
  async trail(@CurrentUser() me: AuthenticatedUser, @Query() q: AdjustmentsQueryDto) {
    return envelope(await this.accounts.trail(me, q));
  }

  // ---- Policy ---------------------------------------------------------------

  @Patch('policy')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "Change the organisation's leave policy (its admins, who approves included). Returns the " +
      'policy and how many accounts followed',
  })
  async patchPolicy(@CurrentUser() me: AuthenticatedUser, @Body() body: PatchLeavePolicyDto) {
    const now = new Date();
    const { applyNow, ...patch } = body;
    // 4.0: the organisation's admins change their organisation's policy.
    if (!isAdminLike(me)) {
      throw new ForbiddenError('Only the organisation admin can change the leave policy.');
    }
    const { before, after, changed } = await this.policies.update(
      requireOrg(me),
      patch as Record<string, unknown>,
      {
        mayRoute: true,
        updatedById: me.id,
      },
    );
    const accounts = await this.accounts.applyPolicy(before, after, applyNow === true, now);
    return envelope({
      policy: LeavePolicyService.view(after, {
        canEdit: true,
        canRoute: true,
        now,
      }),
      changed,
      accountsUpdated: accounts,
    });
  }
}
