import { endStatusMeetingOf } from './status-meeting';

const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00+05:30`);

function tx(record: unknown) {
  return {
    meetingRecord: {
      findUnique: jest.fn().mockResolvedValue(record),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('endStatusMeetingOf (3.6)', () => {
  const running = { id: 'm1', kind: 'STATUS', startedAt: at('10:00'), endedAt: null };

  it('a running status meeting ends with its presence, saying why', async () => {
    const t = tx(running);
    await endStatusMeetingOf(t as never, 'ps1', at('11:00'), 'BREAK');
    expect(t.meetingRecord.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { presenceSessionId: 'ps1' } }),
    );
    expect(t.meetingRecord.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { endedAt: at('11:00'), durationSec: 3600, endReason: 'BREAK' },
    });
  });

  it('never ends before it started', async () => {
    const t = tx(running);
    await endStatusMeetingOf(t as never, 'ps1', at('09:00'), 'AUTO_CLOSED');
    expect(t.meetingRecord.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { endedAt: at('10:00'), durationSec: 0, endReason: 'AUTO_CLOSED' },
    });
  });

  it.each([
    [
      'a declared meeting: the heal on read ends it, and tells its approver',
      { ...running, kind: 'DECLARED' },
    ],
    ['one already ended', { ...running, endedAt: at('10:30') }],
    ['a presence session with no meeting', null],
  ])('leaves alone %s', async (_label, record) => {
    const t = tx(record);
    await endStatusMeetingOf(t as never, 'ps1', at('11:00'), 'END_DAY');
    expect(t.meetingRecord.update).not.toHaveBeenCalled();
  });
});
