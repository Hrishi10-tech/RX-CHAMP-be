import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  PipeTransform,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  APPROVAL_PATH_TYPES,
  ApprovalPathType,
  ApprovalsListQueryDto,
  ApproveItemDto,
  BulkApproveItemsDto,
  MyApprovalsQueryDto,
  RejectItemDto,
} from '../application/dto/approvals.dto';
import { ApprovalsService } from '../application/approvals.service';

/** The `:type` path segment: `break`, `meeting` or `away` (any case), else 400. */
@Injectable()
export class ParseApprovalTypePipe implements PipeTransform<string, ApprovalPathType> {
  transform(value: string): ApprovalPathType {
    const type = String(value ?? '').toLowerCase();
    if (!(APPROVAL_PATH_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException('type must be break, meeting or away');
    }
    return type as ApprovalPathType;
  }
}

@ApiTags('approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'Break and meeting approvals in one list (default: pending, mine). Pending sorted by ' +
      'due time, decided ones newest first.',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: ApprovalsListQueryDto) {
    return envelope(await this.approvals.list(me, q, new Date()));
  }

  @Get('summary')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: 'Counts for the badge: pending, due soon, overdue, escalated, decided today',
  })
  async summary(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.approvals.summary(me, new Date()));
  }

  @Get('me')
  @ApiOperation({
    summary: "The caller's own items from the last days (any role; the agent's waiting list)",
  })
  async mine(@CurrentUser() me: AuthenticatedUser, @Query() q: MyApprovalsQueryDto) {
    return envelope(await this.approvals.mine(me, q.days ?? 7, new Date()));
  }

  @Post('bulk-approve')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: 'Approve up to 200 items; anything not yours or not pending is skipped',
  })
  async bulk(@CurrentUser() me: AuthenticatedUser, @Body() body: BulkApproveItemsDto) {
    return envelope(await this.approvals.bulkApprove(me, body.items, body.note, new Date()));
  }

  @Post(':type/:id/approve')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Approve one item (optional note)' })
  async approve(
    @CurrentUser() me: AuthenticatedUser,
    @Param('type', new ParseApprovalTypePipe()) type: ApprovalPathType,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: ApproveItemDto,
  ) {
    return envelope(await this.approvals.approve(me, type, id, body.note, new Date()));
  }

  @Post(':type/:id/reject')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Reject one item (a note of 3+ characters is required)' })
  async reject(
    @CurrentUser() me: AuthenticatedUser,
    @Param('type', new ParseApprovalTypePipe()) type: ApprovalPathType,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: RejectItemDto,
  ) {
    return envelope(await this.approvals.reject(me, type, id, body.note, new Date()));
  }

  @Post(':type/:id/reopen')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Put a decided item back to pending (the decider or a Super Admin)' })
  async reopen(
    @CurrentUser() me: AuthenticatedUser,
    @Param('type', new ParseApprovalTypePipe()) type: ApprovalPathType,
    @Param('id', new ParseIdPipe()) id: string,
  ) {
    return envelope(await this.approvals.reopen(me, type, id, new Date()));
  }
}
