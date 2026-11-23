import { Prisma } from '@prisma/client';

export type StatusMeetingEndReason = 'USER' | 'BREAK' | 'END_DAY' | 'NO_ANSWER' | 'AUTO_CLOSED';

/**
 * A MEETING presence session was just closed inside `tx` (a break start, End Day, the
 * automatic close, the older presence calls): if it carried a status meeting, the
 * meeting ends with it, at the same instant and with the reason. A declared meeting is
 * left to the heal on read (3.1), which also tells its approver.
 */
export async function endStatusMeetingOf(
  tx: Prisma.TransactionClient,
  presenceSessionId: string,
  endedAt: Date,
  reason: StatusMeetingEndReason,
): Promise<void> {
  const record = await tx.meetingRecord.findUnique({
    where: { presenceSessionId },
    select: { id: true, kind: true, startedAt: true, endedAt: true },
  });
  if (!record || record.kind !== 'STATUS' || record.endedAt) return;
  const end = endedAt.getTime() < record.startedAt.getTime() ? record.startedAt : endedAt;
  await tx.meetingRecord.update({
    where: { id: record.id },
    data: {
      endedAt: end,
      durationSec: Math.max(0, Math.round((end.getTime() - record.startedAt.getTime()) / 1000)),
      endReason: reason,
    },
  });
}
