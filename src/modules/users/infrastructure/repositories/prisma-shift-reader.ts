import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { ShiftReader, ShiftView } from '../../domain/repositories/shift-reader.port';

@Injectable()
export class PrismaShiftReader implements ShiftReader {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<ShiftView | null> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(id)) return null;
    const s = await this.prisma.shift.findFirst({ where: { id, deletedAt: null } });
    return s ? { id: s.id, start: s.start, end: s.end, companyId: s.companyId ?? undefined } : null;
  }

  async companyExists(id: string): Promise<boolean> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(id)) return false;
    const c = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    return c !== null;
  }
}
