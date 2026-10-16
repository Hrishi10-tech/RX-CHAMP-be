import { Module } from '@nestjs/common';
import { PresenceModule } from '@modules/presence/presence.module';
import { SettingsModule } from '@modules/settings/settings.module';
import { BREAK_RECORD_REPOSITORY } from './domain/break-record.repository';
import { SHIFT_PEOPLE_READER } from './domain/shift-people.reader';
import { SHIFT_REPOSITORY } from './domain/shift.repository';
import { PrismaBreakRecordRepository } from './infrastructure/prisma-break-record.repository';
import { PrismaShiftPeopleReader } from './infrastructure/prisma-shift-people.reader';
import { PrismaShiftRepository } from './infrastructure/prisma-shift.repository';
import { ApprovalRerouteSubscriber } from './application/approval-reroute.subscriber';
import { BreakDayService } from './application/break-day.service';
import { ShiftDayResolver } from './application/shift-day.resolver';
import { BreakEvents } from './application/break-events.service';
import { LegacyBreakSubscriber } from './application/legacy-break.subscriber';
import { PresenceBridge } from './application/presence-bridge.service';
import { SkipsNeedingCommentQuery } from './application/skips-needing-comment.query';
import { BreakApprovalsUseCase } from './application/use-cases/break-approvals.use-case';
import { ManageShiftsUseCase } from './application/use-cases/manage-shifts.use-case';
import { MyBreaksUseCase } from './application/use-cases/my-breaks.use-case';
import { ShiftAssignmentsUseCase } from './application/use-cases/shift-assignments.use-case';
import { TeamBreaksUseCase } from './application/use-cases/team-breaks.use-case';
import { BreaksController } from './presentation/breaks.controller';
import { ShiftAssignmentsController, ShiftsController } from './presentation/shifts.controller';

/**
 * Shifts and scheduled breaks: shift definitions with morning, lunch and evening
 * breaks; who works which shift (department, personal override, default); the
 * break flow the agents drive; and the approval of off-schedule breaks.
 *
 * 3.1: the working day (sessions, skips, meetings, unified approvals) lives in
 * the worktime module, which builds on what this module exports. GET
 * /breaks/me/today and POST /breaks/start are served there, because both need the
 * day's work sessions.
 */
@Module({
  imports: [PresenceModule, SettingsModule],
  controllers: [ShiftsController, ShiftAssignmentsController, BreaksController],
  providers: [
    { provide: SHIFT_REPOSITORY, useClass: PrismaShiftRepository },
    { provide: SHIFT_PEOPLE_READER, useClass: PrismaShiftPeopleReader },
    { provide: BREAK_RECORD_REPOSITORY, useClass: PrismaBreakRecordRepository },
    BreakDayService,
    ShiftDayResolver,
    BreakEvents,
    PresenceBridge,
    SkipsNeedingCommentQuery,
    ManageShiftsUseCase,
    ShiftAssignmentsUseCase,
    MyBreaksUseCase,
    BreakApprovalsUseCase,
    TeamBreaksUseCase,
    LegacyBreakSubscriber,
    ApprovalRerouteSubscriber,
  ],
  exports: [
    BreakDayService,
    ShiftDayResolver,
    BreakEvents,
    PresenceBridge,
    SkipsNeedingCommentQuery,
    MyBreaksUseCase,
    BreakApprovalsUseCase,
    SHIFT_REPOSITORY,
    SHIFT_PEOPLE_READER,
    BREAK_RECORD_REPOSITORY,
  ],
})
export class ShiftsModule {}
