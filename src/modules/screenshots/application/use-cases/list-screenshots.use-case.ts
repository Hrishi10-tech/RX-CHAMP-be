import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  SCREENSHOT_REPOSITORY,
  ScreenshotRepository,
} from '../../domain/screenshot.repository';
import {
  SCREENSHOT_ACCESS_READER,
  ScreenshotAccessReader,
} from '../../domain/screenshot-access.reader';
import { S3StorageService } from '../../infrastructure/s3-storage.service';
import { ListScreenshotsQueryDto } from '../dto/list-screenshots-query.dto';
import { ScreenshotMapper } from '../screenshot.mapper';
import { ListScreenshotsResult } from '../screenshot.types';
import { assertCanAccess } from '../screenshot-access';

/** A manager (or admin, or the user themselves) lists a user's screenshots with presigned URLs. */
@Injectable()
export class ListScreenshotsUseCase {
  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(SCREENSHOT_ACCESS_READER) private readonly access: ScreenshotAccessReader,
    private readonly s3: S3StorageService,
  ) {}

  async execute(me: AuthenticatedUser, query: ListScreenshotsQueryDto): Promise<ListScreenshotsResult> {
    await assertCanAccess(me, query.userId, this.access);

    // When the client omits a bound, default the window to "today" in server
    // local time: from = start of the current day (00:00), to = now.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    const filter = {
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      from: query.from ? new Date(query.from) : startOfToday,
      to: query.to ? new Date(query.to) : now,
      kind: query.kind,
      q: query.q,
      includeArchived: query.includeArchived ?? false,
    };

    const [records, total] = await Promise.all([
      this.repo.listForUser(query.userId, filter),
      this.repo.countForUser(query.userId, filter),
    ]);

    const items = await Promise.all(
      records.map(async (r) => ScreenshotMapper.toView(r, await this.s3.presignGet(r.storageKey))),
    );

    return { userId: query.userId, total, items };
  }
}
