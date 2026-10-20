import { hmInZone, minutesToHm, hmToMinutes, time12InZone } from '@shared/utils/timezone';
import {
  BreakRecordRow,
  isSkipRecord,
  needsComment,
  outcomeOf,
  segmentsOf,
  takenSecOf,
} from '../domain/break-record.repository';
import {
  BREAK_LABEL,
  BreakSlot,
  ShiftBreakDef,
  ShiftRecord,
  breakAllowsSkip,
  RECORD_LABEL,
  isScheduledKind,
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
    const state = stateOf(r);
    const inProgress = state === 'ACTIVE';
    const takenSec = isSkipRecord(r) ? 0 : takenSecOf(r, now);
    const lengthMin = r.kind === 'QUICK' ? (r.plannedMin ?? null) : r.durationMin;
    const canResume =
      state === 'PAUSED' && !!r.windowClose && now.getTime() <= r.windowClose.getTime();
    return {
      id: r.id,
      date: r.date,
      kind: r.kind,
      label: r.kind
        ? RECORD_LABEL[r.kind]
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
      tookSec: takenSec,
      // Stored when the break ended through /breaks/end; worked out otherwise.
      // A quick break runs over its planned length (4.0).
      overrunSec:
        r.kind === 'QUICK'
          ? r.plannedMin
            ? Math.max(0, takenSec - r.plannedMin * 60)
            : 0
          : (r.overrunSec ??
            (isSkipRecord(r) || !r.durationMin ? 0 : Math.max(0, takenSec - r.durationMin * 60))),
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
      state,
      takenSec,
      remainingSec: lengthMin ? Math.max(0, lengthMin * 60 - takenSec) : 0,
      plannedMin: r.plannedMin ?? null,
      canResume,
      resumeUntil: canResume ? r.windowClose!.toISOString() : null,
      segments: segmentsOf(r).map((s) => ({
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
      })),
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
      local12: {
        start: time12InZone(slot.scheduledStart, tz),
        end: time12InZone(slot.scheduledEnd, tz),
        windowOpen: time12InZone(slot.windowOpen, tz),
        windowClose: time12InZone(slot.windowClose, tz),
      },
      record,
      state: !record ? 'NOT_TAKEN' : record.outcome !== 'TAKEN' ? 'SKIPPED' : record.state,
      takenSec: record?.takenSec ?? 0,
      remainingSec: record ? record.remainingSec : slot.durationMin * 60,
      canResume: record?.canResume ?? false,
      resumeUntil: record?.resumeUntil ?? null,
      segments: record?.segments ?? [],
    };
  }

  /** A skip waiting for its comment, for the agent's End Day dialog. Null if not one. */
  static skipNeedingComment(r: BreakRecordRow, minChars: number): SkipNeedingComment | null {
    const outcome = outcomeOf(r);
    if (!isScheduledKind(r.kind) || (outcome !== 'SKIPPED' && outcome !== 'AUTO_SKIPPED'))
      return null;
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

/**
 * A record's 4.0 state. Paused is stored; otherwise a running presence session
 * (endedAt null) means ACTIVE, which also covers rows written by 3.x paths.
 */
export function stateOf(r: BreakRecordRow): 'ACTIVE' | 'PAUSED' | 'ENDED' {
  if (isSkipRecord(r)) return 'ENDED';
  if (r.state === 'PAUSED') return 'PAUSED';
  if (r.state === 'ENDED' && r.finalEndedAt) return 'ENDED';
  return r.endedAt === null ? 'ACTIVE' : 'ENDED';
}
