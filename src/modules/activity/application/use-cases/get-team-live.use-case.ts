import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { ActivityMapper } from '../activity.mapper';
import { TeamMemberActivityView } from '../activity.types';
import { localDateString } from '../activity-date.util';

/** A manager's live board: what each report is using right now. */
@Injectable()
export class GetTeamLiveUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
  ) {}

  async execute(managerId: string): Promise<TeamMemberActivityView[]> {
    const now = new Date();
    const reports = await this.access.findReports(managerId);
    if (reports.length === 0) return [];

    const ids = reports.map((r) => r.id);
    const latest = await this.repo.findLatestForUsers(ids);
    const today = localDateString(now);
    // Reports who signed off show as DAY_ENDED instead of ageing into OFFLINE.
    const ended = await this.workDays.findEndsForUsers(ids, today);
    // PC login time, shown beside the live status.
    const logins = await this.workDays.findLoginsForUsers(ids, today);

    return reports.map((member) =>
      ActivityMapper.toTeamMemberView(
        member,
        latest.get(member.id) ?? null,
        now,
        ended.has(member.id),
        logins.get(member.id) ?? null,
      ),
    );
  }
}
