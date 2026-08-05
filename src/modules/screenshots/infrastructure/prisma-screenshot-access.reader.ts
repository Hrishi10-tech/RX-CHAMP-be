import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { ScreenshotAccessReader } from '../domain/screenshot-access.reader';

@Injectable()
export class PrismaScreenshotAccessReader implements ScreenshotAccessReader {
  constructor(private readonly prisma: PrismaService) {}

  async findManagerId(userId: string): Promise<string | null | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { managerId: true },
    });
    return row ? row.managerId : undefined;
  }
}
