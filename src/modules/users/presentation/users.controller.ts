import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  CreateUserItemDto,
  CreateUsersDto,
  ListUsersQueryDto,
  SetUserScreenshotsDto,
  SetUserStatusDto,
  UpdateUserDto,
} from '../application/dto';
import { CreateUsersUseCase } from '../application/use-cases/create-users.use-case';
import { DeleteUserUseCase } from '../application/use-cases/delete-user.use-case';
import { GetProfileUseCase } from '../application/use-cases/get-profile.use-case';
import { ListUsersUseCase } from '../application/use-cases/list-users.use-case';
import { SetUserScreenshotsUseCase } from '../application/use-cases/set-user-screenshots.use-case';
import { SetUserStatusUseCase } from '../application/use-cases/set-user-status.use-case';
import { UpdateUserUseCase } from '../application/use-cases/update-user.use-case';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly listUsers: ListUsersUseCase,
    private readonly getProfile: GetProfileUseCase,
    private readonly createUsers: CreateUsersUseCase,
    private readonly updateUser: UpdateUserUseCase,
    private readonly setStatus: SetUserStatusUseCase,
    private readonly setScreenshots: SetUserScreenshotsUseCase,
    private readonly deleteUser: DeleteUserUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List users (role-scoped)' })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListUsersQueryDto) {
    console.log('req.qeruy loged in to usertable rolebased', query);
    const { users, total, page, limit } = await this.listUsers.execute(me, query);
    const totalPages = Math.ceil(total / limit);
    return envelope(users, { meta: { total, page, limit, totalPages } });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Full detail for one user (self, your report, or any user for an admin)',
  })
  async detail(@CurrentUser() me: AuthenticatedUser, @Param('id') id: string) {
    return this.getProfile.execute(me, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create one or many users (bulk)' })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateUsersDto) {
    const items: CreateUserItemDto[] = Array.isArray(body.users) ? body.users : [body];
    return this.createUsers.execute(me, items);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a user (name, designation, department)' })
  async update(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.updateUser.execute(me, id, body);
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Enable/disable a team member' })
  async status(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetUserStatusDto,
  ) {
    return this.setStatus.execute(me, id, body.status);
  }

  @Post(':id/screenshots')
  @ApiOperation({
    summary:
      "Turn a user's automatic screenshots on or off (admin: anyone, manager: own reports). " +
      'Only the periodic capture is affected — activity tracking and manual capture keep working.',
  })
  async screenshots(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetUserScreenshotsDto,
  ) {
    return this.setScreenshots.execute(me, id, body.enabled);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user (soft delete; history kept)' })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id') id: string) {
    return this.deleteUser.execute(me, id);
  }
}
