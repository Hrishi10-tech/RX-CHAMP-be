import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  CreateUserItemDto,
  CreateUsersDto,
  ListUsersQueryDto,
  SetUserGrantsDto,
  SetUserIdleDto,
  SetUserPasswordDto,
  SetUserScreenshotsDto,
  SetUserStatusDto,
  UpdateUserDto,
} from '../application/dto';
import { CreateUsersUseCase } from '../application/use-cases/create-users.use-case';
import { DeleteUserUseCase } from '../application/use-cases/delete-user.use-case';
import { GetMeUseCase } from '../application/use-cases/get-me.use-case';
import { GetProfileUseCase } from '../application/use-cases/get-profile.use-case';
import { ListUsersUseCase } from '../application/use-cases/list-users.use-case';
import { SetUserGrantsUseCase } from '../application/use-cases/set-user-grants.use-case';
import { SetUserIdleUseCase } from '../application/use-cases/set-user-idle.use-case';
import { SetUserScreenshotsUseCase } from '../application/use-cases/set-user-screenshots.use-case';
import { SetUserStatusUseCase } from '../application/use-cases/set-user-status.use-case';
import { SetUserPasswordUseCase } from '../application/use-cases/set-user-password.use-case';
import { UpdateUserUseCase } from '../application/use-cases/update-user.use-case';

/**
 * People (docs/4.0/SPEC.md 5.3). Every rule is in the use cases through the shared
 * tenancy helpers: Admin and Super Admin (organisation selected) manage people;
 * Managers read their departments' Staff; Staff see themselves. Someone outside
 * the caller's organisation is "unknown" (404), never "forbidden".
 */
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
    private readonly setPassword: SetUserPasswordUseCase,
    private readonly setGrants: SetUserGrantsUseCase,
    private readonly setIdle: SetUserIdleUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'People: Admin/Super Admin everyone in the organisation (filters role, departmentId, q, status); ' +
      "Manager their departments' Staff (few fields); Staff themselves",
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListUsersQueryDto) {
    const { users, total, page, limit } = await this.listUsers.execute(me, query);
    const totalPages = Math.ceil(total / limit);
    return envelope(users, { meta: { total, page, limit, totalPages } });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One person (self, or someone the caller may see)' })
  async detail(@CurrentUser() me: AuthenticatedUser, @Param('id') id: string) {
    return this.getProfile.execute(me, id);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Add a Manager or Staff member to the organisation (Admin, Super Admin). ' +
      'Several at once with { users: [...] } (each row reported).',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateUsersDto) {
    const bulk = Array.isArray(body.users);
    const items: CreateUserItemDto[] = bulk ? body.users! : [body];
    return this.createUsers.execute(me, items, !bulk);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edit a person: names, email, designation, role (Manager/Staff), department(s), grants',
  })
  async update(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.updateUser.execute(me, id, body);
  }

  @Post(':id/grants')
  @HttpCode(200)
  @ApiOperation({
    summary: "A Manager's view grants: screenshots, timeline, activity (Admin, Super Admin)",
  })
  async grants(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: SetUserGrantsDto,
  ) {
    return envelope(
      await this.setGrants.execute(me, id, {
        screenshots: body.screenshots,
        timeline: body.timeline,
        activity: body.activity,
      }),
    );
  }

  @Post(':id/idle')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "A person's input-tracking override (null = use the department's setting) (Admin, Super Admin)",
  })
  async idle(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: SetUserIdleDto,
  ) {
    return envelope(await this.setIdle.execute(me, id, body.enabled ?? null, body.minutes ?? null));
  }

  @Post(':id/status')
  @ApiOperation({ summary: 'Block or unblock a person (Admin, Super Admin)' })
  async status(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetUserStatusDto,
  ) {
    return this.setStatus.execute(me, id, body.status);
  }

  @Post(':id/password')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Set someone's password (Admin: their organisation's Managers and Staff; Super Admin: also its Admin). " +
      'Optionally sign them out everywhere (also invalidates their installer tokens).',
  })
  async password(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetUserPasswordDto,
  ) {
    return this.setPassword.execute(me, id, body.newPassword, body.signOutEverywhere ?? false);
  }

  @Post(':id/screenshots')
  @ApiOperation({
    summary:
      "Turn a person's automatic screenshots on or off (Admin, Super Admin). " +
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
  @ApiOperation({ summary: 'Delete a person (soft delete; history kept) (Admin, Super Admin)' })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id') id: string) {
    return this.deleteUser.execute(me, id);
  }
}

/** GET /me (docs/4.0/SPEC.md 5.3). */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly me: GetMeUseCase) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Who is signed in: role, organisation (Super Admin: the one chosen with X-Org-Id), ' +
      'department(s), grants and the menus the portal may show',
  })
  async get(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.me.execute(me));
  }
}
