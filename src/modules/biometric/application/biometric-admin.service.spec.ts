import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { BiometricAdminService, biometricStretchEnded } from './biometric-admin.service';

const NOW = new Date('2026-11-05T06:00:00.000Z');
const TODAY = '2026-11-05';
// 4.0: the organisation's admin changes who checks in how, for that organisation only.
const ORG = '11111111-1111-4111-8111-111111111111';
const sa = {
  id: 'sa',
  role: Role.ADMIN,
  companyId: ORG,
  orgId: ORG,
} as unknown as AuthenticatedUser;

function person(over: Record<string, unknown>) {
  return {
    id: 'u1',
    firstName: 'Bala',
    lastName: 'K',
    email: 'bala@x.test',
    role: 'USER',
    department: null,
    companyId: ORG,
    companyName: null,
    managerId: null,
    attendanceSource: 'BIOMETRIC',
    biometricCode: 'B1',
    attendanceSourceFrom: '2026-10-01',
    ...over,
  };
}

function setup(before: ReturnType<typeof person>) {
  const repo = {
    people: jest.fn().mockResolvedValue([before]),
    peopleByCodes: jest.fn().mockResolvedValue(new Map()),
    setAttendance: jest.fn().mockResolvedValue(undefined),
    lastPunchOf: jest.fn().mockResolvedValue(new Map()),
  };
  const days = { closeOpen: jest.fn().mockResolvedValue(0) };
  const ingest = { rematch: jest.fn().mockResolvedValue({ punches: 0, daysUpdated: 0 }) };
  const svc = new BiometricAdminService(
    repo as never,
    ingest as never,
    days as never,
    {} as never,
    {} as never,
  );
  return { svc, repo };
}

describe('biometricStretchEnded', () => {
  const on = { attendanceSource: 'BIOMETRIC' as const, attendanceSourceFrom: '2026-10-01' };

  it('back to the agent: the stretch up to yesterday, as the change applies from today', () => {
    expect(biometricStretchEnded(on, 'AGENT', TODAY)).toEqual({
      fromDate: '2026-10-01',
      toDate: '2026-11-04',
    });
  });

  it('a stretch with no recorded start ran from the beginning', () => {
    expect(biometricStretchEnded({ ...on, attendanceSourceFrom: null }, 'AGENT', TODAY)).toEqual({
      fromDate: null,
      toDate: '2026-11-04',
    });
  });

  it('on and off in one day leaves nothing to keep', () => {
    expect(
      biometricStretchEnded({ ...on, attendanceSourceFrom: TODAY }, 'AGENT', TODAY),
    ).toBeNull();
  });

  it('moving onto biometric, or staying, ends nothing', () => {
    expect(biometricStretchEnded(on, 'BIOMETRIC', TODAY)).toBeNull();
    expect(
      biometricStretchEnded(
        { attendanceSource: 'AGENT', attendanceSourceFrom: null },
        'BIOMETRIC',
        TODAY,
      ),
    ).toBeNull();
  });
});

describe('setPeople keeps the source in force on past dates', () => {
  it('moving back to the agent saves the stretch it ends, with who and when', async () => {
    const { svc, repo } = setup(person({}));
    await svc.setPeople(sa, [{ userId: 'u1', attendanceSource: 'AGENT' }], NOW);
    expect(repo.setAttendance).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: 'u1',
          attendanceSource: 'AGENT',
          attendanceSourceFrom: TODAY,
          endedBiometric: { fromDate: '2026-10-01', toDate: '2026-11-04' },
        }),
      ],
      NOW,
      'sa',
    );
  });

  it('anything else writes no stretch', async () => {
    const { svc, repo } = setup(person({ attendanceSource: 'AGENT', attendanceSourceFrom: null }));
    await svc.setPeople(
      sa,
      [{ userId: 'u1', attendanceSource: 'BIOMETRIC', biometricCode: 'B1' }],
      NOW,
    );
    expect(repo.setAttendance.mock.calls[0][0][0]).not.toHaveProperty('endedBiometric');
  });
});
