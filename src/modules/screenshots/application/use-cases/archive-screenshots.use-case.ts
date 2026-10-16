import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { SCREENSHOT_REPOSITORY, ScreenshotRepository } from '../../domain/screenshot.repository';
import {
  SCREENSHOT_ACCESS_READER,
  ScreenshotAccessReader,
} from '../../domain/screenshot-access.reader';
import { ArchiveScreenshotsDto } from '../dto/archive-screenshots.dto';
import { assertCanAccess } from '../screenshot-access';

/** A manager archives screenshots for one of their users; archived shots hide from the default list. */
@Injectable()
export class ArchiveScreenshotsUseCase {
  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(SCREENSHOT_ACCESS_READER) private readonly access: ScreenshotAccessReader,
  ) {}

  async execute(me: AuthenticatedUser, dto: ArchiveScreenshotsDto): Promise<{ archived: number }> {
    // Archiving hides captures from the default view, so nobody may do it to their own.
    if (me.id === dto.userId)
      throw new ForbiddenException('You cannot archive your own screenshots');
    await assertCanAccess(me, dto.userId, this.access);
    return { archived: await this.repo.archive(dto.userId, dto.ids) };
  }
}
