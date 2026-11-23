import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { DayProgressService } from './day-progress.service';

const H = 3600;
const NOW = new Date('2026-11-06T03:30:00.000Z'); // 09:00 in Kolkata, the morning after
const me = { id: 'u1' } as AuthenticatedUser;

type Day = {
  date: string;
  state: 'NOT_STARTED' | 'OPEN' | 'ENDED';
  focusSec: number;
  expectedSec?: number;
  biometric?: boolean;
};

function core(d: Day) {
  return {
    date: d.date,
    state: d.state,
    day: { presence: [], meetingRecords: [], breakRecords: [] },
    focus: { focusSec: d.focusSec },
    expectedSec: d.expectedSec ?? 8 * H,
    shift: { id: 'shift' },
    person: { attendanceSource: d.biometric ? 'BIOMETRIC' : 'AGENT' },
  };
}

function setup(today: Day, days: Record<string, Day>, lastEnded: { date: string } | null) {
  const sessions = { findLastEnded: jest.fn().mockResolvedValue(lastEnded) };
  const workSessions = { autoCloseIfStale: jest.fn().mockResolvedValue(false) };
  const workday = {
    dayCore: jest.fn((_me: unknown, _now: unknown, forDate?: string) =>
      Promise.resolve(core(forDate ? days[forDate] : today)),
    ),
  };
  const svc = new DayProgressService(sessions as never, workSessions as never, workday as never);
  return { svc, sessions, workSessions, workday };
}

const nothingYet: Day = { date: '2026-11-06', state: 'NOT_STARTED', focusSec: 0 };
const endedYesterday: Day = { date: '2026-11-05', state: 'ENDED', focusSec: 8 * H + 15 * 60 };

describe('GET /me/day-progress across a change of date (brief 1.1, D-26, D-30)', () => {
  it('after End day, the next morning: Day ended, with that day and its total', async () => {
    const { svc, workday } = setup(
      nothingYet,
      { '2026-11-05': endedYesterday },
      { date: '2026-11-05' },
    );
    expect(await svc.view(me, NOW)).toMatchObject({
      status: 'ENDED',
      date: '2026-11-05',
      workedSec: 8 * H + 15 * 60,
      targetSec: 8 * H,
      targetFromShift: true,
      overSec: 15 * 60,
    });
    expect(workday.dayCore).toHaveBeenLastCalledWith(me, NOW, '2026-11-05');
  });

  it('however long ago it was: there is no 12 hour limit', async () => {
    const old: Day = { date: '2026-10-02', state: 'ENDED', focusSec: 4 * H };
    const { svc } = setup(nothingYet, { '2026-10-02': old }, { date: '2026-10-02' });
    expect(await svc.view(me, NOW)).toMatchObject({
      status: 'ENDED',
      date: '2026-10-02',
      workedSec: 4 * H,
    });
  });

  it('Not started only for someone with no ended day', async () => {
    const { svc, workday } = setup(nothingYet, {}, null);
    expect(await svc.view(me, NOW)).toMatchObject({
      status: 'NOT_STARTED',
      date: '2026-11-06',
      workedSec: 0,
      overSec: 0,
    });
    expect(workday.dayCore).toHaveBeenCalledTimes(1);
  });

  it('Start day resets it: the new day, with no read of the old one', async () => {
    const started: Day = { date: '2026-11-06', state: 'OPEN', focusSec: 60 };
    const { svc, sessions, workday } = setup(started, {}, { date: '2026-11-05' });
    expect(await svc.view(me, NOW)).toMatchObject({
      status: 'WORKING',
      date: '2026-11-06',
      workedSec: 60,
    });
    expect(sessions.findLastEnded).not.toHaveBeenCalled();
    expect(workday.dayCore).toHaveBeenCalledTimes(1);
  });

  it('a day ended today needs no second read either', async () => {
    const endedToday: Day = { date: '2026-11-06', state: 'ENDED', focusSec: 3 * H };
    const { svc, sessions } = setup(endedToday, {}, { date: '2026-11-06' });
    expect(await svc.view(me, NOW)).toMatchObject({ status: 'ENDED', date: '2026-11-06' });
    expect(sessions.findLastEnded).not.toHaveBeenCalled();
  });

  it('biometric staff follow the same rule from their punches', async () => {
    const lastPunches: Day = { ...endedYesterday, biometric: true };
    const { svc } = setup(
      { ...nothingYet, biometric: true },
      { '2026-11-05': lastPunches },
      { date: '2026-11-05' },
    );
    expect(await svc.view(me, NOW)).toMatchObject({
      status: 'ENDED',
      date: '2026-11-05',
      workedSec: 8 * H + 15 * 60,
    });
  });

  it('a stale day is closed first, so it is the day kept', async () => {
    const { svc, workSessions } = setup(nothingYet, {}, null);
    await svc.view(me, NOW);
    expect(workSessions.autoCloseIfStale).toHaveBeenCalledWith('u1', NOW);
  });
});
