import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { ActivityMapper } from '../activity.mapper';
import { CurrentActivityView } from '../activity.types';
import { assertCanAccess } from '../activity-access';

/** What a single user is using right now (self, their manager, or an admin). */
@Injectable()
export class GetCurrentActivityUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
  ) {}

  async execute(me: AuthenticatedUser, userId: string): Promise<CurrentActivityView> {
    await assertCanAccess(me, userId, this.access);
    const latest = await this.repo.findLatestForUser(userId);
    return ActivityMapper.toCurrentView(latest, new Date());
  }
}
