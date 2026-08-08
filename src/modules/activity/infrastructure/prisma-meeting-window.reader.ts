import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { MeetingWindow, MeetingWindowReader } from '../domain/meeting-window.reader';

@Injectable()
export class PrismaMeetingWindowReader implements MeetingWindowReader {
  constructor(private readonly prisma: PrismaService) {}

  async listForUserByDate(userId: string, date: string): Promise<MeetingWindow[]> {
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId, date, type: 'MEETING' },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true, endedAt: true },
    });
    return rows.map((r) => ({ start: r.startedAt, end: r.endedAt }));
  }
}
