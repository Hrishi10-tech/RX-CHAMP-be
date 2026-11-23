import { ApprovalChangedEvent } from '@shared/events/approval-changed.event';
import { NoticeEvent } from '@shared/events/notice.event';
import { LeaveJobs } from './leave.jobs';

const NOW = new Date('2026-11-05T06:00:00Z');

function request(dates: string[], status = 'PENDING') {
  return {
    id: 'l1',
    userId: 'u1',
    category: 'CLSL',
    kind: 'FULL_DAY',
    part: null,
    status,
    units: dates.length * 2,
    reason: 'Family function',
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    days: dates.map((date) => ({ date, units: 2 })),
  };
}

function setup(row: ReturnType<typeof request>, off: string[]) {
  const tx = {
    findRequest: jest.fn().mockResolvedValue(row),
    isMonthLocked: jest.fn().mockResolvedValue(false),
    updateRequest: jest.fn(async (_id: string, patch: Record<string, unknown>) => ({
      ...row,
      ...patch,
    })),
  };
  const repo = {
    activeRequestsFrom: jest.fn().mockResolvedValue([row]),
    inUserLock: jest.fn(async (_userId: string, work: (t: typeof tx) => unknown) => work(tx)),
  };
  const people = {
    any: jest.fn().mockResolvedValue(new Map([['u1', { id: 'u1', role: 'USER' }]])),
    dayInfos: jest.fn(async (_p: unknown, dates: string[]) =>
      dates.map((date) => ({ date, workday: !off.includes(date), offLabel: 'Holiday' })),
    ),
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const job = new LeaveJobs(
    repo as never,
    {} as never,
    events as never,
    {} as never,
    people as never,
  );
  return { job, events };
}

const notice = (events: { publish: jest.Mock }) =>
  events.publish.mock.calls.find(([name]) => name === NoticeEvent.eventName)?.[1] as NoticeEvent;

describe('LeaveJobs: a calendar change reaches open lists (3.6)', () => {
  it('a request every day of which became a day off is closed, and announced as cancelled', async () => {
    const { job, events } = setup(request(['2026-11-16']), ['2026-11-16']);
    await expect(job.reprice(NOW)).resolves.toBe(1);
    expect(notice(events).approval).toEqual({ what: 'LEAVE', id: 'l1', action: 'CANCELLED' });
  });

  it('a request that only shrinks is announced as changed', async () => {
    const { job, events } = setup(request(['2026-11-16', '2026-11-17']), ['2026-11-16']);
    await expect(job.reprice(NOW)).resolves.toBe(1);
    expect(notice(events).approval).toEqual({ what: 'LEAVE', id: 'l1', action: 'UPDATED' });
  });

  it('the notice itself still goes to the person alone', async () => {
    const { job, events } = setup(request(['2026-11-16']), ['2026-11-16']);
    await job.reprice(NOW);
    expect(notice(events).recipientIds).toEqual(['u1']);
    expect(
      events.publish.mock.calls.filter(([name]) => name === ApprovalChangedEvent.eventName),
    ).toEqual([]);
  });

  it('nothing changed, nothing said', async () => {
    const { job, events } = setup(request(['2026-11-16']), []);
    await expect(job.reprice(NOW)).resolves.toBe(0);
    expect(events.publish).not.toHaveBeenCalled();
  });
});
