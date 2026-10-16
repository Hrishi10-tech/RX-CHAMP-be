import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  myUpdateFor,
  redactAck,
  redactActivity,
  redactCurrent,
  seesOwnActivity,
} from './activity-redaction';
import { ActivityAck, CurrentActivityView, MyActivityUpdate } from './activity.types';
import { GetCurrentActivityUseCase } from './use-cases/get-current-activity.use-case';

const current: CurrentActivityView = {
  status: 'ACTIVE',
  app: 'EXCEL.EXE',
  title: 'Claims batch 7',
  url: 'https://payer.example/claims',
  idle: false,
  lastSampleAt: '2026-10-14T05:00:00.000Z',
  staleSec: 20,
};

const update: MyActivityUpdate = {
  current,
  date: '2026-10-14',
  activeSec: 3600,
  idleSec: 600,
  workingBasisSec: 32400,
  remainingSec: 28800,
  clockedOut: false,
  dayEnded: false,
  topApps: [{ name: 'EXCEL.EXE', seconds: 3600 } as never],
};

describe('staff never see activity (SPEC 1.8)', () => {
  it('only Managers and Super Admins see their own', () => {
    expect(seesOwnActivity(Role.MANAGER)).toBe(true);
    expect(seesOwnActivity(Role.SUPER_ADMIN)).toBe(true);
    expect(seesOwnActivity(Role.USER)).toBe(false);
    expect(seesOwnActivity(undefined)).toBe(false);
  });

  it('the report ack keeps its shape, dayEnded and the capture switches', () => {
    const ack: ActivityAck = {
      ok: true,
      activeSec: 33000,
      workingBasisSec: 32400,
      remainingSec: 0,
      clockedOut: true,
      dayEnded: true,
      shouldCapture: false,
      screenshotsEnabled: false,
    };
    expect(redactAck(ack)).toEqual({
      ...ack,
      activeSec: 0,
      remainingSec: 32400,
      clockedOut: false,
    });
  });

  it('the current view keeps the status, without app, title or URL', () => {
    expect(redactCurrent(current)).toEqual({ ...current, app: null, title: null, url: null });
  });

  it('the activity:me push: no figures, no apps, no current app', () => {
    expect(myUpdateFor(Role.USER, update)).toEqual({
      ...update,
      current: { ...current, app: null, title: null, url: null },
      activeSec: 0,
      idleSec: 0,
      remainingSec: 32400,
      clockedOut: false,
      topApps: [],
    });
    expect(myUpdateFor(Role.MANAGER, update)).toBe(update);
  });

  it('the day view is emptied', () => {
    const daily = {
      date: '2026-10-14',
      activeSec: 10,
      idleSec: 5,
      workingBasisSec: 32400,
      extraSec: 1,
      remainingSec: 1,
      clockedOut: true,
      dayEnded: false,
      loginAt: null,
      clockInAt: null,
      clockOutAt: null,
      topApps: [{} as never],
      topWebsites: [{} as never],
      hourly: [{} as never],
    };
    expect(redactActivity(daily)).toMatchObject({
      activeSec: 0,
      idleSec: 0,
      extraSec: 0,
      remainingSec: 32400,
      clockedOut: false,
      topApps: [],
      topWebsites: [],
      hourly: [],
    });
  });
});

describe('GET /activity/me/current and /activity/user/:me/current', () => {
  const sample = {
    id: 's1',
    userId: 'u1',
    deviceId: null,
    date: '2026-10-14',
    at: new Date(Date.now() - 10_000),
    durationSec: 0,
    idle: false,
    locked: false,
    app: 'EXCEL.EXE',
    title: 'Claims batch 7',
    url: 'https://payer.example/claims',
  };
  const setup = () => {
    const repo = { findLatestForUser: jest.fn().mockResolvedValue(sample) };
    const access = { findManagerId: jest.fn().mockResolvedValue('m1') };
    const workDays = { findEnd: jest.fn().mockResolvedValue(null) };
    return new GetCurrentActivityUseCase(repo as never, access as never, workDays as never);
  };
  const user = (id: string, role: Role) => ({ id, role }) as unknown as AuthenticatedUser;

  it('staff get the status without app, title or URL', async () => {
    const view = await setup().execute(user('u1', Role.USER), 'u1');
    expect(view).toMatchObject({ status: 'ACTIVE', app: null, title: null, url: null });
  });

  it("a manager sees a report's current app", async () => {
    const view = await setup().execute(user('m1', Role.MANAGER), 'u1');
    expect(view).toMatchObject({ app: 'EXCEL.EXE', title: 'Claims batch 7' });
  });
});
