import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { reasonAccepted } from '@modules/settings/domain/reason-presets';
import { lateStartDetail } from '../domain/attendance';
import { LateStartService } from './late-start.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 14, h, m) - 330 * 60_000);
};

const SHIFT = {
  id: 'sh1',
  name: 'General',
  start: '10:00',
  end: '19:00',
  workDays: [1, 2, 3, 4, 5, 6],
  breaks: [],
  reasonMinChars: 10,
};

const staff = { id: 'u1', role: 'USER', department: 'Billing', companyId: null, managerId: 'm1' };
const me = (role = Role.USER) => ({ id: 'u1', role }) as AuthenticatedUser;

function setup(
  opts: { workday?: boolean; sessions?: unknown[]; open?: unknown; require?: boolean } = {},
) {
  const sessions = {
    findOpen: jest.fn().mockResolvedValue(opts.open ?? null),
    listForUserOnDate: jest.fn().mockResolvedValue(opts.sessions ?? []),
    setLateReason: jest.fn(async (id: string, reason: string, at: Date) => ({
      id,
      startedAt: ist('10:25'),
      lateReason: reason,
      lateReasonAt: at,
    })),
  };
  const people = { findById: jest.fn().mockResolvedValue(staff) };
  const days = {
    context: jest.fn().mockResolvedValue({}),
    dayOn: jest.fn().mockReturnValue({
      resolved: { shift: SHIFT },
      workday: opts.workday ?? true,
      calendar: { kind: opts.workday === false ? 'HOLIDAY' : 'WORKING', holidayName: null },
      slots: [],
    }),
  };
  const dayKeys = {
    keyFnFor: jest.fn(async () => () => '2026-10-14'),
    dayKeyAt: jest.fn(async () => '2026-10-14'),
  };
  const settings = {
    get: jest.fn().mockResolvedValue({
      lateStartGraceMin: 10,
      requireLateStartReason: opts.require ?? true,
    }),
  };
  const list = { LATE_DAY_START: ['Traffic'] } as Record<string, string[]>;
  const presets = {
    get: jest.fn().mockResolvedValue(list),
    accepts: jest.fn(async (kind: string, text: string | null, min: number) =>
      reasonAccepted(text, min, list[kind]),
    ),
  };
  const events = { publish: jest.fn(async () => undefined) };
  // 4.0: the day plan (organisation calendar and settings) decides the working day.
  const plans = {
    context: jest.fn(async () => ({
      settingsOf: () => ({
        lateStartGraceMin: 10,
        requireLateStartReason: opts.require ?? true,
      }),
      plan: () => ({ shift: SHIFT, isWorkingDay: opts.workday ?? true }),
    })),
  };
  const svc = new LateStartService(
    sessions as never,
    people as never,
    days as never,
    dayKeys as never,
    settings as never,
    presets as never,
    events as never,
    plans as never,
  );
  return { svc, sessions, events };
}

const CAN_ASK = { lateStartReason: true };
const CANNOT_ASK = { lateStartReason: false };

describe('LateStartService.gate (fix 1)', () => {
  it('within the grace asks nothing: 10:10 on a 10:00 shift with 10 minutes grace', async () => {
    const { svc } = setup();
    expect(await svc.gate(me(), ist('10:10'), undefined, CAN_ASK)).toBeNull();
  });

  it('beyond the grace, an agent that can ask gets 422 LATE_REASON_REQUIRED with the presets', async () => {
    const { svc } = setup();
    await expect(svc.gate(me(), ist('10:25'), undefined, CAN_ASK)).rejects.toMatchObject({
      status: 422,
      code: 'LATE_REASON_REQUIRED',
      details: expect.objectContaining({ minutesLate: 25, graceMin: 10, presets: ['Traffic'] }),
    });
    await expect(svc.gate(me(), ist('10:25'), 'Too short', CAN_ASK)).rejects.toMatchObject({
      code: 'LATE_REASON_REQUIRED',
    });
  });

  it('takes a preset as it is, even under the minimum length (3.2)', async () => {
    const { svc } = setup();
    // "Traffic" is 7 characters against a 10-character minimum, but it is a preset.
    expect(await svc.gate(me(), ist('10:25'), 'Traffic', CAN_ASK)).toMatchObject({
      reason: 'Traffic',
    });
    expect(await svc.gate(me(), ist('10:25'), ' traffic ', CAN_ASK)).toMatchObject({
      reason: 'traffic',
    });
    await expect(svc.gate(me(), ist('10:25'), 'Traffic!', CAN_ASK)).rejects.toMatchObject({
      code: 'LATE_REASON_REQUIRED',
    });
  });

  it('keeps a reason that is long enough', async () => {
    const { svc } = setup();
    const r = await svc.gate(me(), ist('10:25'), '  Traffic on the ring road ', CAN_ASK);
    expect(r).toMatchObject({ reason: 'Traffic on the ring road', late: { minutes: 25 } });
  });

  it('an older agent starts the day as before (the reason comes from the portal)', async () => {
    const { svc } = setup();
    const r = await svc.gate(me(), ist('10:25'), undefined, CANNOT_ASK);
    expect(r).toMatchObject({ reason: null, late: { minutes: 25, reasonRequired: true } });
  });

  it('a resume after End Day, a day off, or the setting off never asks', async () => {
    expect(
      await setup({ sessions: [{ id: 's0' }] }).svc.gate(me(), ist('11:00'), undefined, CAN_ASK),
    ).toBeNull();
    expect(
      await setup({ workday: false }).svc.gate(me(), ist('11:00'), undefined, CAN_ASK),
    ).toBeNull();
    const off = await setup({ require: false }).svc.gate(me(), ist('11:00'), undefined, CAN_ASK);
    expect(off).toMatchObject({ late: { reasonRequired: false }, reason: null });
  });

  it('reminds the person in the portal when the agent could not ask', async () => {
    const { svc, events } = setup();
    const r = await svc.gate(me(), ist('10:25'), undefined, CANNOT_ASK);
    await svc.remind('u1', r!.late);
    expect(events.publish).toHaveBeenCalledWith(
      'notice.send',
      expect.objectContaining({ recipientIds: ['u1'], type: 'LATE_START_REASON' }),
    );
  });
});

describe('LateStartService.addReason (portal)', () => {
  it('stores the reason on the day’s first session', async () => {
    const { svc, sessions } = setup({
      sessions: [{ id: 's1', startedAt: ist('10:25'), lateReason: null }],
    });
    const r = await svc.addReason(me(), { reason: 'Doctor appointment' }, ist('12:00'));
    expect(sessions.setLateReason).toHaveBeenCalledWith('s1', 'Doctor appointment', ist('12:00'));
    expect(r.lateStart).toMatchObject({
      minutes: 25,
      reason: 'Doctor appointment',
      needsReason: false,
    });
  });

  it('refuses a day that was not late, and a reason that is too short', async () => {
    const onTime = setup({ sessions: [{ id: 's1', startedAt: ist('10:05') }] });
    await expect(
      onTime.svc.addReason(me(), { reason: 'Doctor appointment' }, ist('12:00')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'NOT_LATE',
    });
    const late = setup({ sessions: [{ id: 's1', startedAt: ist('10:25') }] });
    await expect(late.svc.addReason(me(), { reason: 'Late' }, ist('12:00'))).rejects.toMatchObject({
      status: 422,
      code: 'REASON_REQUIRED',
    });
  });

  it('takes a preset in the portal too', async () => {
    const { svc } = setup({ sessions: [{ id: 's1', startedAt: ist('10:25'), lateReason: null }] });
    const r = await svc.addReason(me(), { reason: 'Traffic' }, ist('12:00'));
    expect(r.lateStart).toMatchObject({ reason: 'Traffic', needsReason: false });
  });
});

describe('lateStartDetail', () => {
  it('asks for a reason only when none was given, the setting is on, and someone reviews it', () => {
    const first = { startedAt: ist('10:25') };
    const base = { shiftStart: ist('10:00'), graceMin: 10, requireReason: true };
    expect(lateStartDetail({ ...base, first })).toMatchObject({ minutes: 25, needsReason: true });
    expect(lateStartDetail({ ...base, first, exempt: true })?.needsReason).toBe(false);
    expect(lateStartDetail({ ...base, requireReason: false, first })?.needsReason).toBe(false);
    expect(
      lateStartDetail({
        ...base,
        first: { ...first, lateReason: 'Traffic jam', lateReasonAt: ist('10:30') },
      }),
    ).toMatchObject({ reason: 'Traffic jam', needsReason: false });
    expect(lateStartDetail({ ...base, first: { startedAt: ist('10:10') } })).toBeNull();
  });
});
