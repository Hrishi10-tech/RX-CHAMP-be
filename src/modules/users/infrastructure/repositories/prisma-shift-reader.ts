import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { ShiftReader, ShiftView } from '../../domain/repositories/shift-reader.port';

@Injectable()
export class PrismaShiftReader implements ShiftReader {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<ShiftView | null> {
    const s = await this.prisma.shift.findFirst({ where: { id, deletedAt: null } });
    return s ? { id: s.id, start: s.start, end: s.end, companyId: s.companyId ?? undefined } : null;
  }
}
