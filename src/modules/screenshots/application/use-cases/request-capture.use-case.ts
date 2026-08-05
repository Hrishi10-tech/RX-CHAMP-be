import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  SCREENSHOT_ACCESS_READER,
  ScreenshotAccessReader,
} from '../../domain/screenshot-access.reader';
import { ScreenshotsGateway } from '../../presentation/screenshots.gateway';
import { assertCanAccess } from '../screenshot-access';

/** A manager asks a user's agent to capture a screenshot right now (over the socket). */
@Injectable()
export class RequestCaptureUseCase {
  constructor(
    @Inject(SCREENSHOT_ACCESS_READER) private readonly access: ScreenshotAccessReader,
    private readonly gateway: ScreenshotsGateway,
  ) {}

  async execute(me: AuthenticatedUser, targetUserId: string): Promise<{ requested: boolean }> {
    await assertCanAccess(me, targetUserId, this.access);
    this.gateway.emitCaptureRequest(targetUserId);
    return { requested: true };
  }
}
