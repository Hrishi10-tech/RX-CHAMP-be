import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
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
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { requireOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { CalendarService } from '../application/calendar.service';
import { LABEL_MAX } from '../domain/calendar.rules';

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
}

/** Working days and holidays (docs/4.0/SPEC.md 2.6, 5.5). */
@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

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
      await this.calendar.setDay(requireOrg(me), date, body.isWorking, body.label, me.id),
    );
  }

  @Delete('days/:date')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Put a date back to the week pattern (Admin)' })
  async clearDay(@CurrentUser() me: AuthenticatedUser, @Param('date') date: string) {
    return envelope(await this.calendar.clearDay(requireOrg(me), date));
  }
}
