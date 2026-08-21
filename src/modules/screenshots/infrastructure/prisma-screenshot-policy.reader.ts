import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { ScreenshotPolicyReader } from '../domain/screenshot-policy.reader';

@Injectable()
export class PrismaScreenshotPolicyReader implements ScreenshotPolicyReader {
  constructor(private readonly prisma: PrismaService) {}

  async isAutoEnabled(userId: string): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { screenshotsEnabled: true },
    });
    // An unknown user is rejected elsewhere; default to enabled so a lookup miss
    // can never silently switch capturing off for someone.
    return row?.screenshotsEnabled ?? true;
  }
}
