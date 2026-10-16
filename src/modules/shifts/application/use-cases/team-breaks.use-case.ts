import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { dateKeyInZone } from '@shared/utils/timezone';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
  isSkipRecord,
  outcomeOf,
} from '../../domain/break-record.repository';
import { phaseAt } from '../../domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '../../domain/shift-people.reader';
import { BreakSlot } from '../../domain/shift.types';
import { BreakDayService } from '../break-day.service';
import { personName } from '../break-events.service';
import { TeamBreaksQueryDto } from '../dto';
import { ShiftMapper } from '../shift.mapper';
import { hmInZone } from '@shared/utils/timezone';
import {
  BreakRecordView,
  TeamBreakCellView,
  TeamBreakRowView,
  TeamBreaksView,
  TeamCellStatus,
} from '../shifts.types';
import { personView } from './break-approvals.use-case';

/**
 * One day of breaks for a team: who took what, when, late or early, missed,
 * still running, and what is waiting for approval.
 */
@Injectable()
export class TeamBreaksUseCase {
  constructor(
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
  ) {}

  async execute(me: AuthenticatedUser, q: TeamBreaksQueryDto): Promise<TeamBreaksView> {
    if (me.role !== Role.SUPER_ADMIN && me.role !== Role.MANAGER)
      throw new ForbiddenError('Not allowed');
    const now = new Date();
    const tz = this.days.timezone;
    const date = q.date ?? dateKeyInZone(now, tz);

    let team: ShiftPerson[];
    if (me.role === Role.MANAGER) {
      team = await this.people.findMany({ managerId: me.id });
    } else if (q.managerId) {
      const manager = await this.people.findById(q.managerId);
      if (!manager) throw new NotFoundError('Unknown manager');
      team = await this.people.findMany({ managerId: q.managerId });
    } else {
      team = (await this.people.listAllActive()).filter((p) => p.id !== me.id);
    }

    const ids = team.map((p) => p.id);
    const [ctx, rows] = await Promise.all([
      this.days.context(ids),
      this.records.listForUsersOnDate(ids, date),
    ]);
    const deciders = rows.map((r) => r.decidedById).filter((x): x is string => !!x);
    const names = new Map(
      (await this.people.findAnyByIds(deciders)).map((p) => [p.id, personName(p)] as const),
    );

    const byUser = new Map<string, BreakRecordRow[]>();
    for (const r of rows) {
      const list = byUser.get(r.userId) ?? [];
      list.push(r);
      byUser.set(r.userId, list);
    }

    const totals = {
      people: team.length,
      taken: 0,
      late: 0,
      early: 0,
      missed: 0,
      overrun: 0,
      pending: 0,
      skipped: 0,
    };
    const out: TeamBreakRowView[] = [];

    for (const p of team.sort((a, b) => personName(a).localeCompare(personName(b)))) {
      const day = this.days.forDate(this.days.resolveWith(ctx, p, date), date);
      const mine = byUser.get(p.id) ?? [];
      const views = new Map<string, BreakRecordView>(
        mine.map((r) => [r.id, ShiftMapper.recordView(r, now, names)]),
      );

      const cells: TeamBreakCellView[] = day.slots.map((slot) => {
        const rec = mine.find((r) => r.kind === slot.kind) ?? null;
        const status = this.cellStatus(slot, rec, now);
        if (status === 'MISSED') totals.missed += 1;
        return {
          kind: slot.kind,
          label: slot.label,
          localStart: hmInZone(slot.scheduledStart, tz),
          status,
          record: rec ? views.get(rec.id)! : null,
        };
      });

      for (const r of mine) {
        const v = views.get(r.id)!;
        if (r.approvalStatus === 'PENDING') totals.pending += 1;
        if (isSkipRecord(r)) {
          totals.skipped += 1;
          continue;
        }
        totals.taken += 1;
        if (r.timing === 'LATE') totals.late += 1;
        if (r.timing === 'EARLY') totals.early += 1;
        if (v.overrunSec > 0 && !v.inProgress) totals.overrun += 1;
      }

      out.push({
        user: personView(p, p.id),
        shift: ShiftMapper.ref(day.resolved.shift),
        source: day.resolved.source,
        workday: day.workday,
        cells,
        unscheduled: mine.filter((r) => !r.kind).map((r) => views.get(r.id)!),
        pending: mine.filter((r) => r.approvalStatus === 'PENDING').length,
      });
    }

    return { date, rows: out, totals };
  }

  private cellStatus(slot: BreakSlot, rec: BreakRecordRow | null, now: Date): TeamCellStatus {
    if (rec) {
      const outcome = outcomeOf(rec);
      if (outcome !== 'TAKEN') return outcome;
      return rec.endedAt ? 'TAKEN' : 'IN_PROGRESS';
    }
    const phase = phaseAt(slot, now);
    if (phase === 'UPCOMING') return 'UPCOMING';
    if (phase === 'CLOSED') return 'MISSED';
    return 'OPEN';
  }
}
