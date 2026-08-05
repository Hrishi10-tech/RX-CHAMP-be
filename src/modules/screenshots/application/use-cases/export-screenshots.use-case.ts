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
import { ExportScreenshotsQueryDto } from '../dto/export-screenshots-query.dto';
import { assertCanAccess } from '../screenshot-access';

/** Builds a CSV manifest (id, takenAt, kind, presigned url) of a user's screenshots. */
@Injectable()
export class ExportScreenshotsUseCase {
  private static readonly MAX = 5000;

  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(SCREENSHOT_ACCESS_READER) private readonly access: ScreenshotAccessReader,
    private readonly s3: S3StorageService,
  ) {}

  async execute(me: AuthenticatedUser, query: ExportScreenshotsQueryDto): Promise<string> {
    await assertCanAccess(me, query.userId, this.access);

    const records = await this.repo.listForUser(query.userId, {
      limit: ExportScreenshotsUseCase.MAX,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      kind: query.kind,
      includeArchived: true,
    });

    const rows = await Promise.all(
      records.map(async (r) => {
        const url = await this.s3.presignGet(r.storageKey, 24 * 3600);
        return [r.id, r.takenAt.toISOString(), r.kind, url];
      }),
    );

    const header = 'id,takenAt,kind,url';
    const body = rows.map((cols) => cols.map(csvCell).join(',')).join('\n');
    return `${header}\n${body}\n`;
  }
}

/** Minimal CSV escaping. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
