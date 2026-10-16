import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { appTimezone, hmInZone } from '@shared/utils/timezone';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { BreakEvents, personName } from '@modules/shifts/application/break-events.service';
import { PresenceBridge } from '@modules/shifts/application/presence-bridge.service';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import { AgentGeneration } from '../domain/agent-generation';
import { wholeMinutes } from '../domain/approval-copy';
import {
  MEETING_RECORD_REPOSITORY,
  MeetingRecordRepository,
  MeetingRecordRow,
} from '../domain/meeting-record.repository';
import { cleanParticipants, cleanText } from '../domain/meetings';
import { meetingRequestedCopy, NOTICE } from '../domain/notice-copy';
import { WORKTIME_READER, WorktimeReader } from '../domain/worktime.reader';
import { LogPastMeetingDto, StartMeetingDto } from './dto/meetings.dto';
import { dayClosedError, WorkSessionsService } from './work-sessions.service';
import { CurrentPresenceLite, MeetingRecordView } from './worktime.types';

export const AGENDA_MAX = 300;

/** A meeting record as clients see it (SPEC 3.3). */
export function meetingView(
  m: MeetingRecordRow,
  now: Date,
  names?: Map<string, string>,
): MeetingRecordView {
  const inProgress = m.mode === 'LIVE' && m.endedAt === null;
  return {
    id: m.id,
    date: m.date,
    mode: m.mode,
    agenda: m.agenda,
    participants: m.participants.map((p) => (p.id ? { id: p.id, name: p.name } : { name: p.name })),
    startedAt: m.startedAt.toISOString(),
    endedAt: m.endedAt?.toISOString() ?? null,
    inProgress,
    durationSec: inProgress
      ? Math.max(0, Math.round((now.getTime() - m.startedAt.getTime()) / 1000))
      : (m.durationSec ?? 0),
    approvalStatus: m.approvalStatus,
    dueAt: m.dueAt?.toISOString() ?? null,
    decidedAt: m.decidedAt?.toISOString() ?? null,
    decisionNote: m.decisionNote,
    decidedByName: m.decidedById ? (names?.get(m.decidedById) ?? null) : null,
  };
}

/**
 * Meetings (SPEC 1.6): started live from the agent, or logged afterwards. Both
 * count as focus time as they happen and go to the person's approver; a live one
 * becomes decidable when it ends.
 */
@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly sessions: WorkSessionsService,
    private readonly breakEvents: BreakEvents,
    private readonly presence: PresenceBridge,
  ) {}

  private async person(id: string): Promise<ShiftPerson> {
    const p = await this.people.findById(id);
    if (!p) throw new NotFoundError('User not found');
    return p;
  }

  private async route(person: ShiftPerson) {
    const manager = person.managerId ? await this.people.findById(person.managerId) : null;
    const r = BreakApprovalPolicy.route(person, manager);
    return {
      approvalStatus: r.status === 'PENDING' ? ('PENDING' as const) : ('NOT_REQUIRED' as const),
      routing: { approverRole: r.approverRole, approverId: r.approverId },
    };
  }

  private async details(me: AuthenticatedUser, dto: StartMeetingDto) {
    const agenda = cleanText(dto.agenda);
    if (!agenda || agenda.length > AGENDA_MAX) {
      throw new ValidationError(
        `Give the meeting an agenda (1 to ${AGENDA_MAX} characters).`,
        'VALIDATION_ERROR',
      ).withDetails({ field: 'agenda' });
    }
    const ids = (dto.participants ?? []).map((p) => p.id).filter((x): x is string => !!x);
    const known = ids.length
      ? await this.reader.knownPeopleIds(me.companyId, ids)
      : new Set<string>();
    return { agenda, participants: cleanParticipants(dto.participants ?? [], known) };
  }

  async start(
    me: AuthenticatedUser,
    dto: StartMeetingDto,
    generation: AgentGeneration,
    now: Date,
  ): Promise<{ meeting: MeetingRecordView; presence: CurrentPresenceLite }> {
    await this.sessions.autoCloseIfStale(me.id, now);
    const person = await this.person(me.id);
    const { agenda, participants } = await this.details(me, dto);
    // The person's working day (a night shift past midnight is still the evening's).
    const today = await this.sessions.todayFor(me.id, now);
    const result = await this.meetings.startLive(
      { userId: me.id, date: today, agenda, participants, ...(await this.route(person)) },
      generation,
      now,
      today,
    );
    if (!result.ok) {
      switch (result.code) {
        case 'ON_BREAK':
          throw new ConflictError(
            "You're on a break. End it before starting a meeting.",
            'ON_BREAK',
          );
        case 'MEETING_IN_PROGRESS':
          throw new ConflictError(
            "You're already in a meeting. End it before starting another.",
            'MEETING_IN_PROGRESS',
          );
        default:
          throw dayClosedError(result.code);
      }
    }
    void this.presence.broadcast(
      me.id,
      {
        id: result.presenceSessionId,
        userId: me.id,
        deviceId: null,
        type: 'MEETING',
        note: agenda,
        date: today,
        startedAt: now,
        endedAt: null,
        durationSec: null,
      },
      now,
    );
    return {
      meeting: meetingView(result.record, now),
      presence: {
        status: 'MEETING',
        sessionId: result.presenceSessionId,
        note: agenda,
        since: now.toISOString(),
        elapsedSec: 0,
      },
    };
  }

  /** Ends a live meeting (idempotent); one under a minute is discarded. */
  async end(
    me: AuthenticatedUser,
    id: string,
    now: Date,
  ): Promise<{ meeting: MeetingRecordView | null; discarded: boolean }> {
    const found = await this.meetings.findById(id);
    if (!found) throw new NotFoundError('Unknown meeting');
    if (found.userId !== me.id) throw new ForbiddenError('This meeting is not yours.');
    const result = await this.meetings.endLive(id, me.id, now);
    if (!result) throw new NotFoundError('Unknown meeting');
    if (result.kind === 'UNCHANGED')
      return { meeting: meetingView(result.record, now), discarded: false };
    void this.presence.broadcast(me.id, null, now);
    if (result.kind === 'DISCARDED') return { meeting: null, discarded: true };
    await this.requested(result.record);
    return { meeting: meetingView(result.record, now), discarded: false };
  }

  async logPast(
    me: AuthenticatedUser,
    dto: LogPastMeetingDto,
    generation: AgentGeneration,
    now: Date,
  ): Promise<{ meeting: MeetingRecordView }> {
    await this.sessions.autoCloseIfStale(me.id, now);
    const person = await this.person(me.id);
    const { agenda, participants } = await this.details(me, dto);
    const startedAt = new Date(dto.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      throw new ValidationError(
        'startedAt must be an ISO-8601 instant.',
        'VALIDATION_ERROR',
      ).withDetails({
        field: 'startedAt',
      });
    }
    // The person's working day (a night shift past midnight is still the evening's).
    const today = await this.sessions.todayFor(me.id, now);
    const result = await this.meetings.createPast(
      {
        userId: me.id,
        date: today,
        agenda,
        participants,
        startedAt,
        durationSec: dto.durationMin * 60,
        ...(await this.route(person)),
      },
      generation,
      now,
      today,
    );
    if (!result.ok) {
      if ('code' in result) throw dayClosedError(result.code);
      const c = result.conflict;
      const message = {
        MEETING_IN_FUTURE: 'That meeting ends after now. Log only meetings that have happened.',
        MEETING_OUTSIDE_DAY: "That meeting is not inside today's working time (Start Day to now).",
        MEETING_OVERLAPS_BREAK: 'That meeting overlaps a break or lunch.',
        MEETING_OVERLAPS_MEETING: 'That meeting overlaps another meeting.',
      }[c.code];
      const err = new UnprocessableError(message, c.code);
      throw c.with ? err.withDetails({ with: c.with }) : err;
    }
    await this.requested(result.record);
    return { meeting: meetingView(result.record, now) };
  }

  async today(me: AuthenticatedUser, now: Date): Promise<{ items: MeetingRecordView[] }> {
    await this.heal([me.id], now);
    const open = await this.sessions.findOpen(me.id);
    const day = open?.date ?? (await this.sessions.todayFor(me.id, now));
    const rows = await this.meetings.listForUserOnDate(me.id, day);
    const names = await this.names(rows);
    return { items: rows.map((m) => meetingView(m, now, names)) };
  }

  async participants(
    me: AuthenticatedUser,
    q: string | undefined,
  ): Promise<{ items: { id: string; name: string; department: string | null }[] }> {
    const rows = await this.reader.searchParticipants(me.companyId, cleanText(q), me.id, 50);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: `${r.firstName} ${r.lastName}`.trim(),
        department: r.department,
      })),
    };
  }

  /**
   * Heal on read: a live meeting whose presence session was closed another way
   * (a break, End Day, auto-close, an older client) takes that end; one under a
   * minute is discarded. The approver is told about each one that now waits.
   */
  async heal(userIds: string[] | null, now: Date): Promise<void> {
    const result = await this.meetings.heal(userIds);
    for (const m of result.healed) await this.requested(m);
    if (result.healed.length || result.discarded) {
      this.logger.debug(
        `healed ${result.healed.length} live meeting(s), discarded ${result.discarded} (${now.toISOString()})`,
      );
    }
  }

  async names(rows: MeetingRecordRow[]): Promise<Map<string, string>> {
    const ids = rows.map((r) => r.decidedById).filter((x): x is string => !!x);
    if (!ids.length) return new Map();
    return new Map((await this.people.findAnyByIds(ids)).map((p) => [p.id, personName(p)]));
  }

  /** MEETING_REQUESTED to whoever decides it, once the meeting can be decided. */
  private async requested(m: MeetingRecordRow): Promise<void> {
    try {
      if (m.approvalStatus !== 'PENDING' || !m.endedAt) return;
      const recipients = await this.breakEvents.recipientsFor(m);
      if (!recipients.length) return;
      const subject = await this.people.findById(m.userId);
      const tz = appTimezone();
      const copy = meetingRequestedCopy({
        name: subject ? personName(subject) : 'Someone',
        agenda: m.agenda,
        minutes: wholeMinutes(m.durationSec ?? 0),
        from: hmInZone(m.startedAt, tz),
        to: hmInZone(m.endedAt, tz),
      });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(recipients, NOTICE.MEETING_REQUESTED, copy.title, copy.body, m.userId),
      );
    } catch (err) {
      this.logger.warn(`meeting notice for ${m.id} failed: ${(err as Error).message}`);
    }
  }
}
