import { assertCanSee, grantsOf, PersonFactsReader } from '@shared/tenancy';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { MEETING_WINDOW_READER, MeetingWindowReader } from '../../domain/meeting-window.reader';
import { ActivityMapper } from '../activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from '../activity.constants';
import { DailyActivityView } from '../activity.types';
import { localDateString } from '../activity-date.util';
import { dailyFor, redactActivity, seesOwnActivity } from '../activity-redaction';

/**
 * A user's day rolled up: active/idle seconds, top apps, top websites, an hourly
 * split and clock in/out — for the user themselves, their manager, or an admin.
 */
@Injectable()
export class GetDailyActivityUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    private readonly facts: PersonFactsReader,
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
    @Inject(MEETING_WINDOW_READER) private readonly meetings: MeetingWindowReader,
  ) {}

  async execute(me: AuthenticatedUser, userId: string, date?: string): Promise<DailyActivityView> {
    // 4.0: apps and sites need the timeline grant, active/idle time and the hourly
    // split the activity grant; a Manager with neither is refused (403), and each
    // part they lack comes back empty.
    let grants = { timeline: true, activity: true };
    if (me.id !== userId) {
      assertCanSee(me, await this.facts.find(userId));
      grants = grantsOf(me);
      if (!grants.timeline && !grants.activity) {
        throw new ForbiddenError(
          'You do not have access to the timeline or activity.',
          'GRANT_REQUIRED',
        );
      }
    }
    const now = new Date();
    const day = date ?? localDateString(now);
    const samples = await this.repo.listForUserByDate(userId, day);
    const end = await this.workDays.findEnd(userId, day);
    const meetings = await this.meetings.listForUserByDate(userId, day);
    const login = await this.workDays.findLogin(userId, day);
    const daily = ActivityMapper.computeDaily(
      samples,
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
      end?.endedAt ?? null,
      meetings,
      login,
    );
    // 3.1: staff never see activity. Same shape (200, so older agents keep
    // reading dayEnded), with every activity figure emptied.
    return seesOwnActivity(me.role) ? dailyFor(daily, grants) : redactActivity(daily);
  }
}
