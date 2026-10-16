import { hmInZone, minutesToHm, hmToMinutes } from '@shared/utils/timezone';
import { overrunSeconds } from '../domain/break-schedule';
import {
  BreakRecordRow,
  isSkipRecord,
  needsComment,
  outcomeOf,
} from '../domain/break-record.repository';
import {
  BREAK_LABEL,
  BreakSlot,
  ShiftBreakDef,
  ShiftRecord,
  breakAllowsSkip,
} from '../domain/shift.types';
import {
  BreakRecordView,
  BreakSlotView,
  ShiftBreakView,
  ShiftRef,
  ShiftView,
  SkipNeedingComment,
} from './shifts.types';

export class ShiftMapper {
  static ref(shift: ShiftRecord | null | undefined): ShiftRef | null {
    return shift ? { id: shift.id, name: shift.name, start: shift.start, end: shift.end } : null;
  }

  static breakView(b: ShiftBreakDef, shift: ShiftRecord): ShiftBreakView {
    const s = hmToMinutes(b.startTime);
    return {
      kind: b.kind,
      label: BREAK_LABEL[b.kind],
      enabled: b.enabled,
      startTime: b.startTime,
      durationMin: b.durationMin,
      windowBeforeMin: b.windowBeforeMin,
      windowAfterMin: b.windowAfterMin,
      allowSkip: breakAllowsSkip(b),
      endTime: minutesToHm(s + b.durationMin),
      windowOpen: minutesToHm(s - b.windowBeforeMin),
      windowClose: minutesToHm(s + b.windowAfterMin),
      ringStart: minutesToHm(s - shift.ringLeadMin),
      ringEnd: minutesToHm(s - shift.ringLeadMin + shift.ringDurationMin),
    };
  }

  static shiftView(shift: ShiftRecord, usage: ShiftView['usage']): ShiftView {
    return {
      id: shift.id,
      companyId: shift.companyId,
      name: shift.name,
      start: shift.start,
      end: shift.end,
      overnight: hmToMinutes(shift.end) <= hmToMinutes(shift.start),
      workDays: shift.workDays,
      isDefault: shift.isDefault,
      rules: {
        ringLeadMin: shift.ringLeadMin,
        ringDurationMin: shift.ringDurationMin,
        ringSound: shift.ringSound,
        reasonOnEarly: shift.reasonOnEarly,
        reasonOnLate: shift.reasonOnLate,
        reasonMinChars: shift.reasonMinChars,
        overrunReason: shift.overrunReason,
        overrunGraceMin: shift.overrunGraceMin,
      },
      breaks: shift.breaks.map((b) => this.breakView(b, shift)),
      usage,
      createdAt: shift.createdAt.toISOString(),
      updatedAt: shift.updatedAt.toISOString(),
    };
  }

  static recordView(r: BreakRecordRow, now: Date, names?: Map<string, string>): BreakRecordView {
    const inProgress = r.endedAt === null;
    const end = r.endedAt ?? now;
    return {
      id: r.id,
      date: r.date,
      kind: r.kind,
      label: r.kind
        ? BREAK_LABEL[r.kind]
        : r.presenceType === 'LUNCH'
          ? 'Lunch (unscheduled)'
          : 'Break (unscheduled)',
      presenceType: r.presenceType,
      shiftName: r.shiftName,
      scheduledStart: r.scheduledStart?.toISOString() ?? null,
      durationMin: r.durationMin,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      inProgress,
      tookSec: Math.max(0, Math.round((end.getTime() - r.startedAt.getTime()) / 1000)),
      // Stored when the break ended through /breaks/end; worked out otherwise.
      overrunSec:
        r.overrunSec ??
        (isSkipRecord(r) ? 0 : overrunSeconds(r.durationMin, r.startedAt, r.endedAt, now)),
      timing: r.timing,
      minutesOff: r.minutesOff,
      reason: r.reason,
      overrunReason: r.overrunReason,
      source: r.source,
      approvalStatus: r.approvalStatus,
      approverRole: r.approverRole,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      decidedByName: r.decidedById ? (names?.get(r.decidedById) ?? null) : null,
      outcome: outcomeOf(r),
      overrunAsked: r.overrunAsked ?? false,
      commentedAt: r.commentedAt?.toISOString() ?? null,
      dueAt: r.dueAt?.toISOString() ?? null,
      needsComment: needsComment(r),
    };
  }

  static slotView(slot: BreakSlot, tz: string, record: BreakRecordView | null): BreakSlotView {
    return {
      kind: slot.kind,
      label: slot.label,
      presenceType: slot.presenceType,
      allowSkip: slot.allowSkip,
      durationMin: slot.durationMin,
      scheduledStart: slot.scheduledStart.toISOString(),
      scheduledEnd: slot.scheduledEnd.toISOString(),
      windowOpen: slot.windowOpen.toISOString(),
      windowClose: slot.windowClose.toISOString(),
      ringStart: slot.ringStart.toISOString(),
      ringEnd: slot.ringEnd.toISOString(),
      local: {
        start: hmInZone(slot.scheduledStart, tz),
        end: hmInZone(slot.scheduledEnd, tz),
        windowOpen: hmInZone(slot.windowOpen, tz),
        windowClose: hmInZone(slot.windowClose, tz),
        ringStart: hmInZone(slot.ringStart, tz),
        ringEnd: hmInZone(slot.ringEnd, tz),
      },
      record,
    };
  }

  /** A skip waiting for its comment, for the agent's End Day dialog. Null if not one. */
  static skipNeedingComment(r: BreakRecordRow, minChars: number): SkipNeedingComment | null {
    const outcome = outcomeOf(r);
    if (!r.kind || (outcome !== 'SKIPPED' && outcome !== 'AUTO_SKIPPED')) return null;
    return {
      id: r.id,
      date: r.date,
      kind: r.kind,
      label: BREAK_LABEL[r.kind],
      outcome,
      skippedAt: r.startedAt.toISOString(),
      scheduledStart: r.scheduledStart?.toISOString() ?? null,
      durationMin: r.durationMin,
      minChars,
    };
  }
}
