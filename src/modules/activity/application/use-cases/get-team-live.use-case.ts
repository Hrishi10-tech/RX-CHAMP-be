import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { ActivityMapper } from '../activity.mapper';
import { TeamMemberActivityView } from '../activity.types';

/** A manager's live board: what each report is using right now. */
@Injectable()
export class GetTeamLiveUseCase {
  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
  ) {}

  async execute(managerId: string): Promise<TeamMemberActivityView[]> {
    const now = new Date();
    const reports = await this.access.findReports(managerId);
    if (reports.length === 0) return [];

    const latest = await this.repo.findLatestForUsers(reports.map((r) => r.id));
    return reports.map((member) =>
      ActivityMapper.toTeamMemberView(member, latest.get(member.id) ?? null, now),
    );
  }
}
