import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsUUID,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { API_COPY } from '@shared/copy/api-copy';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { canSeePerson, PersonFactsReader, requireOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { CalendarService } from '../application/calendar.service';
import { LABEL_MAX, SATURDAY_RULES } from '../domain/calendar.rules';

class CalendarQueryDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

class WeekPatternDto {
  @ApiProperty({
    example: [1, 2, 3, 4, 5, 6],
    description: 'ISO weekdays: 1 = Monday .. 7 = Sunday',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days!: number[];

  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'The date the pattern applies from (default today, business time). Earlier days keep ' +
      'their pattern; a date in or before a month locked for payroll is refused (409 MONTH_LOCKED).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date like 2026-11-01' })
  from?: string;
}

class CalendarDayDto {
  @ApiProperty()
  @IsBoolean()
  isWorking!: boolean;

  @ApiPropertyOptional({ example: 'Diwali', maxLength: LABEL_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(LABEL_MAX)
  label?: string;

  @ApiPropertyOptional({
    type: [String],
    description: '3.5: only for these departments (a department holiday); empty: everyone',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  departmentIds?: string[];
}

class SaturdaysDto {
  @ApiProperty({ enum: SATURDAY_RULES })
  @IsIn(SATURDAY_RULES as unknown as string[])
  saturdays!: string;

  @ApiPropertyOptional({
    example: '2026-11-07',
    description: 'ALTERNATE: a Saturday that is worked',
  })
  @IsOptional()
  @IsString()
  saturdayAnchor?: string;
}

class WorkWeekDto extends SaturdaysDto {
  @ApiProperty({
    type: [String],
    description: 'The departments or people (one week for all of them)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  ids!: string[];

  @ApiProperty({
    example: [1, 2, 3, 4, 5, 6],
    description: 'ISO weekdays: 1 = Monday .. 7 = Sunday',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workDays!: number[];
}

class ClearWorkWeekDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  ids!: string[];
}

const SCOPES: Record<string, 'DEPARTMENT' | 'PERSON'> = {
  departments: 'DEPARTMENT',
  people: 'PERSON',
};

function scopeOf(raw: string): 'DEPARTMENT' | 'PERSON' {
  const scope = SCOPES[raw];
  if (!scope) throw new NotFoundException('Unknown calendar scope');
  return scope;
}

/** Working days and holidays (docs/4.0/SPEC.md 2.6, 5.5). */
@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly facts: PersonFactsReader,
  ) {}

  private thisYear(): number {
    return Number(dateKeyInZone(new Date(), appTimezone()).slice(0, 4));
  }

  @Get()
  @ApiOperation({ summary: "The organisation's calendar for a year (anyone in the organisation)" })
  async get(@CurrentUser() me: AuthenticatedUser, @Query() q: CalendarQueryDto) {
    const year = q.year ?? Number(dateKeyInZone(new Date(), appTimezone()).slice(0, 4));
    return envelope(await this.calendar.view(requireOrg(me), year));
  }

  @Put('week-pattern')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Set the working weekdays from a date on (default today; Admin). Days before it keep ' +
      'their pattern; the answer carries the current pattern and its history.',
  })
  async weekPattern(@CurrentUser() me: AuthenticatedUser, @Body() body: WeekPatternDto) {
    const companyId = requireOrg(me);
    await this.calendar.setWeekPattern(companyId, body.days, me.id, body.from);
    return envelope(
      await this.calendar.view(
        companyId,
        Number(dateKeyInZone(new Date(), appTimezone()).slice(0, 4)),
      ),
    );
  }

  @Put('days/:date')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Make a date working or non-working, with an optional label (Admin)' })
  async setDay(
    @CurrentUser() me: AuthenticatedUser,
    @Param('date') date: string,
    @Body() body: CalendarDayDto,
  ) {
    return envelope(
      await this.calendar.setDay(
        requireOrg(me),
        date,
        body.isWorking,
        body.label,
        me.id,
        body.departmentIds ?? [],
      ),
    );
  }

  @Put('saturdays')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      "3.5: the organisation's Saturday rule (every, none, 2nd and 4th off, 1st and 3rd off, " +
      '1st, 3rd and 5th off, alternate weeks) for Saturdays in its week pattern (Admin)',
  })
  async saturdays(@CurrentUser() me: AuthenticatedUser, @Body() body: SaturdaysDto) {
    const companyId = requireOrg(me);
    await this.calendar.setSaturdays(companyId, body.saturdays, body.saturdayAnchor, me.id);
    return envelope(await this.calendar.view(companyId, this.thisYear()));
  }

  @Put(':scope')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '3.5: a week of their own for departments or people (scope departments or people; Admin). ' +
      "A person's own week comes first, then their department's, then the organisation's.",
  })
  async setWeek(
    @CurrentUser() me: AuthenticatedUser,
    @Param('scope') scope: string,
    @Body() body: WorkWeekDto,
  ) {
    const companyId = requireOrg(me);
    await this.calendar.setWorkWeek(companyId, scopeOf(scope), body.ids, body, me.id);
    return envelope(await this.calendar.view(companyId, this.thisYear()));
  }

  @Delete(':scope')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: "3.5: back to the department's or the organisation's week (Admin)" })
  async clearWeek(
    @CurrentUser() me: AuthenticatedUser,
    @Param('scope') scope: string,
    @Body() body: ClearWorkWeekDto,
  ) {
    const companyId = requireOrg(me);
    await this.calendar.clearWorkWeek(companyId, scopeOf(scope), body.ids);
    return envelope(await this.calendar.view(companyId, this.thisYear()));
  }

  @Get('people/:userId/year')
  @ApiOperation({
    summary:
      "3.5: a person's year, day by day, with what decides each day (themselves, or anyone " +
      'the caller may see)',
  })
  async personYear(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() q: CalendarQueryDto,
  ) {
    const companyId = requireOrg(me);
    const person = await this.facts.find(userId);
    if (!person || person.companyId !== companyId || !canSeePerson(me, person)) {
      // C-911: someone else's calendar never says "your profile".
      throw new NotFoundException(
        userId === me.id ? API_COPY.profileNotFound : API_COPY.personNotFound,
      );
    }
    return envelope(
      await this.calendar.personYear(
        companyId,
        { id: person.id, departmentId: person.departmentId },
        q.year ?? this.thisYear(),
      ),
    );
  }

  @Delete('days/:date')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Put a date back to the week pattern (Admin)' })
  async clearDay(@CurrentUser() me: AuthenticatedUser, @Param('date') date: string) {
    return envelope(await this.calendar.clearDay(requireOrg(me), date));
  }
}
