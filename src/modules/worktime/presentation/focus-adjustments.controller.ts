import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
  AdjustFocusDto,
  ListAdjustmentsQueryDto,
  MyAdjustmentsQueryDto,
} from '../application/dto/focus-adjustments.dto';
import { FocusAdjustmentsService } from '../application/focus-adjustments.service';

/** Manual focus adjustments (3.3): the Super Manager's correction tool for a rollout. */
@ApiTags('focus-adjustments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('focus-adjustments')
export class FocusAdjustmentsController {
  constructor(private readonly adjustments: FocusAdjustmentsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Your own adjustments (any role), newest first' })
  async mine(@CurrentUser() me: AuthenticatedUser, @Query() q: MyAdjustmentsQueryDto) {
    return envelope(await this.adjustments.mine(me, q.month));
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.SUPER_MANAGER, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'Adjustments, newest first (Manager: the Staff of their departments; Admin: the ' +
      'organisation; Super Manager and Super Admin: the organisation in view, or every one)',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: ListAdjustmentsQueryDto) {
    return envelope(await this.adjustments.list(me, q, new Date()));
  }

  @Post()
  @HttpCode(201)
  @Roles(Role.SUPER_MANAGER)
  @ApiOperation({
    summary:
      "Add minutes to or take minutes off one person's focus time for a day, with a reason " +
      "(Super Manager only, while the person's organisation allows it; a locked month is refused)",
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: AdjustFocusDto) {
    return envelope(await this.adjustments.create(me, body, new Date()));
  }

  @Delete(':id')
  @Roles(Role.SUPER_MANAGER)
  @ApiOperation({ summary: 'Undo an adjustment (it stays in the trail as voided)' })
  async void(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.adjustments.void(me, id, new Date()));
  }
}
