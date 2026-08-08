import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { ActivityMapper } from '../activity.mapper';
import { CurrentActivityView } from '../activity.types';
import { assertCanAccess } from '../activity-access';
import { localDateString } from '../activity-date.util';

/** What a single user is using right now (self, their manager, or an admin). */
@Injectable()
export class GetCurrentActivityUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
  ) {}

  async execute(me: AuthenticatedUser, userId: string): Promise<CurrentActivityView> {
    await assertCanAccess(me, userId, this.access);
    const now = new Date();
    const latest = await this.repo.findLatestForUser(userId);
    // Signed off for the day reads as DAY_ENDED, not as "stopped reporting".
    const ended = await this.workDays.findEnd(userId, localDateString(now));
    return ActivityMapper.toCurrentView(latest, now, ended !== null);
  }
}
