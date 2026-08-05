import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { ActivityMapper } from '../activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from '../activity.constants';
import { DailyActivityView } from '../activity.types';
import { assertCanAccess } from '../activity-access';
import { localDateString } from '../activity-date.util';

/**
 * A user's day rolled up: active/idle seconds, top apps, top websites, an hourly
 * split and clock in/out — for the user themselves, their manager, or an admin.
 */
@Injectable()
export class GetDailyActivityUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
  ) {}

  async execute(me: AuthenticatedUser, userId: string, date?: string): Promise<DailyActivityView> {
    await assertCanAccess(me, userId, this.access);
    const now = new Date();
    const day = date ?? localDateString(now);
    const samples = await this.repo.listForUserByDate(userId, day);
    const end = await this.workDays.findEnd(userId, day);
    return ActivityMapper.computeDaily(
      samples,
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
      end?.endedAt ?? null,
    );
  }
}
