import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  ApprovalsQueryDto,
  BulkApproveDto,
  DecideBreakDto,
  EndBreakDto,
  MyHistoryQueryDto,
  RejectBreakDto,
  SummaryQueryDto,
  TeamBreaksQueryDto,
} from '../application/dto';
import { BreakApprovalsUseCase } from '../application/use-cases/break-approvals.use-case';
import { MyBreaksUseCase } from '../application/use-cases/my-breaks.use-case';
import { TeamBreaksUseCase } from '../application/use-cases/team-breaks.use-case';
import { ParseIdPipe } from '@shared/validation/is-id';

@ApiTags('breaks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('breaks')
export class BreaksController {
  constructor(
    private readonly mine: MyBreaksUseCase,
    private readonly approvals: BreakApprovalsUseCase,
    private readonly team: TeamBreaksUseCase,
  ) {}

  // ---- Everyone (agent and portal) -----------------------------------------
  // GET /breaks/me/today, POST /breaks/start, /breaks/skip and /breaks/:id/comment
  // are served by the worktime module (WorkdayBreaksController): they need the
  // day's work sessions.

  @Post('end')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'End the running break: back to work (idempotent). Over the grace: askToCount ' +
      'true asks the manager to count the minutes (needs a reason), false leaves them out.',
  })
  async end(@CurrentUser() me: AuthenticatedUser, @Body() body: EndBreakDto) {
    return envelope(await this.mine.end(me, body));
  }

  @Get('me/history')
  @ApiOperation({ summary: 'My breaks over the last days, with approval decisions' })
  async history(@CurrentUser() me: AuthenticatedUser, @Query() query: MyHistoryQueryDto) {
    return envelope(await this.mine.history(me, query.days ?? 14));
  }

  // ---- Approvers -----------------------------------------------------------

  @Get('approvals')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Breaks waiting for (or given) a decision' })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ApprovalsQueryDto) {
    const { items, meta } = await this.approvals.list(me, query);
    return envelope(items, { meta });
  }

  @Get('approvals/summary')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: 'Counts for the approvals badge: pending today, overdue, decided today',
  })
  async summary(@CurrentUser() me: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return envelope(await this.approvals.summary(me, query.date));
  }

  @Post('approvals/bulk-approve')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: 'Approve many at once; anything not yours or already decided is skipped',
  })
  async bulkApprove(@CurrentUser() me: AuthenticatedUser, @Body() body: BulkApproveDto) {
    return envelope(await this.approvals.bulkApprove(me, body));
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Approve one break' })
  async approve(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: DecideBreakDto,
  ) {
    return envelope(await this.approvals.approve(me, id, body.note));
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Reject one break (a note is required; the staff member sees it)' })
  async reject(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: RejectBreakDto,
  ) {
    return envelope(await this.approvals.reject(me, id, body.note));
  }

  @Post('approvals/:id/reopen')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Put a decided break back to pending' })
  async reopen(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.approvals.reopen(me, id));
  }

  @Get('team')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "One day of a team's breaks: taken, late, early, skipped, running" })
  async teamDay(@CurrentUser() me: AuthenticatedUser, @Query() query: TeamBreaksQueryDto) {
    return envelope(await this.team.execute(me, query));
  }
}
