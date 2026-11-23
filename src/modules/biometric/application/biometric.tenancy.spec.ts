import { Role } from '@shared/rbac/roles.enum';
import { ROLES_KEY } from '@shared/rbac/roles.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { BiometricController } from '../presentation/biometric.controller';
import { biometricFromStored } from '../domain/biometric-settings';
import { NewPunch, PunchRecord } from '../domain/biometric.repository';
import { BiometricAdminService } from './biometric-admin.service';
import { BiometricIngestService } from './biometric-ingest.service';
import { BiometricPullService } from './biometric-pull.service';
import { BiometricSettingsService, biometricKeys } from './biometric-settings.service';

/**
 * Biometric attendance (3.5) on 4.0's organisations: each runs its own integration.
 * A key, a pull or an admin sends punches for one organisation; a code matches that
 * organisation's people only (the same code may belong to someone in another); the
 * settings, the pull and the month locks are the organisation's.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-23T06:00:00Z');

const actor = (id: string, role: Role, orgId: string | null = ORG_A) =>
  ({
    id,
    role,
    companyId: role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER ? null : orgId,
    orgId,
    departmentId: null,
    managedDepartmentIds: [],
  }) as unknown as AuthenticatedUser;

const biometricPerson = (id: string, companyId: string, code: string) => ({
  id,
  firstName: id,
  lastName: '',
  email: `${id}@rx.test`,
  role: 'USER',
  department: null,
  departmentId: null,
  companyId,
  companyName: null,
  managerId: null,
  active: true,
  attendanceSource: 'BIOMETRIC' as const,
  biometricCode: code,
  attendanceSourceFrom: null,
});
// The same code in two organisations: 4.0 allows it (unique within one).
const PEOPLE = [biometricPerson('asha', ORG_A, '1001'), biometricPerson('bala', ORG_B, '1001')];

function fakeRepo() {
  const stored: PunchRecord[] = [];
  return {
    stored,
    peopleByCodes: jest.fn(async (companyId: string, keys: string[]) => {
      const out = new Map();
      for (const p of PEOPLE) {
        if (p.companyId === companyId && keys.includes(p.biometricCode))
          out.set(p.biometricCode, p);
      }
      return out;
    }),
    people: jest.fn(async (f: { companyId: string; ids?: string[] }) =>
      PEOPLE.filter((p) => p.companyId === f.companyId && (!f.ids || f.ids.includes(p.id))),
    ),
    lockedMonths: jest.fn(async () => new Set<string>()),
    punchesOfDays: jest.fn(async () => []),
    insertPunches: jest.fn(async (rows: NewPunch[]) => {
      const inserted = rows.map(
        (r, i) =>
          ({
            ...r,
            id: `p${stored.length + i}`,
            voidedAt: null,
            voidedById: null,
            voidReason: null,
            receivedAt: NOW,
          }) as PunchRecord,
      );
      stored.push(...inserted);
      return { inserted, duplicates: 0 };
    }),
    findPunch: jest.fn(async (id: string) => stored.find((p) => p.id === id) ?? null),
    voidPunch: jest.fn(),
    companyIds: jest.fn(async () => [ORG_A, ORG_B]),
  };
}

function ingestWith(repo: ReturnType<typeof fakeRepo>) {
  const shiftPeople = {
    findAnyByIds: jest.fn(async (ids: string[]) => PEOPLE.filter((p) => ids.includes(p.id))),
  };
  const days = {
    context: jest.fn(async () => ({})),
    dayWith: jest.fn(() => ({ dateKey: '2026-11-23' })),
  };
  const settings = { get: jest.fn(async () => biometricFromStored(null)) };
  const biometricDays = { rebuild: jest.fn(async (_userId: string) => 1) };
  const svc = new BiometricIngestService(
    repo as never,
    shiftPeople as never,
    days as never,
    settings as never,
    biometricDays as never,
  );
  return { svc, settings, biometricDays };
}

const PUNCH = { code: '1001', time: '2026-11-23T03:30:00Z', direction: 'IN' };

describe('biometric punches per organisation (4.0)', () => {
  it("a code matches the sending organisation's person only", async () => {
    const repo = fakeRepo();
    const { svc, settings, biometricDays } = ingestWith(repo);
    await svc.ingest(ORG_A, [PUNCH], 'PUSH', { now: NOW, keyId: 'key-a' });
    await svc.ingest(ORG_B, [PUNCH], 'PUSH', { now: NOW, keyId: 'key-b' });
    expect(repo.stored.map((p) => [p.companyId, p.userId])).toEqual([
      [ORG_A, 'asha'],
      [ORG_B, 'bala'],
    ]);
    expect(settings.get).toHaveBeenCalledWith(ORG_A);
    expect(settings.get).toHaveBeenCalledWith(ORG_B);
    expect(repo.lockedMonths).toHaveBeenCalledWith(ORG_A, ['2026-11']);
    expect(biometricDays.rebuild.mock.calls.map((c) => c[0])).toEqual(['asha', 'bala']);
  });

  it("a code nobody in the organisation has stays unmatched there, even if another organisation's person has it", async () => {
    const repo = fakeRepo();
    const { svc } = ingestWith(repo);
    const r = await svc.ingest(ORG_A, [{ ...PUNCH, code: '2002' }], 'CSV', { now: NOW });
    expect(r.unmatched).toBe(1);
    expect(repo.stored[0]).toMatchObject({ companyId: ORG_A, userId: null });
  });
});

describe('the Attendance page per organisation (4.0)', () => {
  function admin(repo = fakeRepo()) {
    const { svc: ingest } = ingestWith(repo);
    const keys = { list: jest.fn(async () => []) };
    const days = { rebuild: jest.fn(async () => 1) };
    return {
      repo,
      svc: new BiometricAdminService(
        repo as never,
        ingest,
        days as never,
        keys as never,
        {} as never,
      ),
    };
  }

  it("another organisation's punch does not exist (404); its own can be voided", async () => {
    const { svc, repo } = admin();
    const { svc: ingest } = ingestWith(repo);
    await ingest.ingest(ORG_B, [PUNCH], 'PUSH', { now: NOW });
    await expect(
      svc.voidPunch(actor('admin-a', Role.ADMIN), 'p0', 'Wrong person', NOW),
    ).rejects.toMatchObject({ status: 404 });
    repo.voidPunch.mockImplementation(async () => ({ ...repo.stored[0], voidedAt: NOW }));
    repo.findPunch.mockResolvedValueOnce(repo.stored[0]);
    (repo as unknown as { names: jest.Mock }).names = jest.fn(async () => new Map());
    await expect(
      svc.voidPunch(actor('admin-b', Role.ADMIN, ORG_B), 'p0', 'Wrong person', NOW),
    ).resolves.toMatchObject({ voided: true });
  });

  it('people of another organisation are unknown when setting attendance', async () => {
    const { svc } = admin();
    await expect(
      svc.setPeople(actor('admin-a', Role.ADMIN), [{ userId: 'bala', biometricCode: '9' }], NOW),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('Managers and Staff never see it; the Super Manager reads; changes are the admins', async () => {
    const { svc } = admin();
    await expect(svc.unmatched(actor('m', Role.MANAGER))).rejects.toMatchObject({ status: 403 });
    await expect(svc.unmatched(actor('u', Role.USER))).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.importCsv(actor('sm', Role.SUPER_MANAGER), 'code,time\n1,2026-11-23 09:00', NOW),
    ).rejects.toMatchObject({ status: 403 });
    // A Super Admin on "All organisations" picks one first.
    await expect(
      svc.importCsv(actor('sa', Role.SUPER_ADMIN, null), 'code,time\n1,2026-11-23 09:00', NOW),
    ).rejects.toMatchObject({ code: 'ORG_REQUIRED' });
  });
});

describe('biometric settings and the pull per organisation (4.0)', () => {
  it("each organisation's settings, secret and pull state are its own, with no fallback", async () => {
    const rows = new Map<string, unknown>([['biometric', { duplicateWindowSec: 300 }]]);
    const store = {
      read: jest.fn(async (k: string) => rows.get(k) ?? null),
      write: jest.fn(async (k: string, v: unknown) => void rows.set(k, v)),
    };
    const svc = new BiometricSettingsService(store as never, {} as never);
    // The 3.5 platform-wide value is never read by an organisation.
    expect((await svc.get(ORG_A)).duplicateWindowSec).toBe(
      biometricFromStored(null).duplicateWindowSec,
    );
    await svc.update(ORG_A, { duplicateWindowSec: 120, secret: 'tok-a' }, 'admin-a');
    expect(rows.get(biometricKeys(ORG_A).secret)).toEqual({ secret: 'tok-a', password: null });
    expect((await svc.secrets(ORG_B)).secret).toBeNull();
    expect((await svc.get(ORG_B)).duplicateWindowSec).not.toBe(120);
  });

  it('the pull job runs only the organisations that switched it on, each once', async () => {
    const settings = {
      get: jest.fn(async (companyId: string) => {
        const s = biometricFromStored(null);
        return companyId === ORG_B
          ? { ...s, pull: { ...s.pull, enabled: true, url: 'https://bio.example.test/api' } }
          : s;
      }),
      pullState: jest.fn(async () => ({ lastRunAt: null })),
    };
    const pull = new BiometricPullService(settings as never, {} as never, fakeRepo() as never);
    const run = jest.spyOn(pull, 'run').mockResolvedValue({} as never);
    await pull.tick(NOW);
    expect(run.mock.calls).toEqual([[ORG_B, NOW, false]]);
  });
});

describe('the integration switch and the payroll pause per organisation (3.6 on 4.0)', () => {
  const rolesOf = (method: 'patchSettings' | 'getSettings'): Role[] =>
    Reflect.getMetadata(ROLES_KEY, BiometricController.prototype[method]);

  it("the organisation's admins (a Super Admin acting in it) switch it; the Super Manager reads", () => {
    expect([...rolesOf('patchSettings')].sort()).toEqual([Role.ADMIN, Role.SUPER_ADMIN].sort());
    expect([...rolesOf('getSettings')].sort()).toEqual(
      [Role.ADMIN, Role.SUPER_ADMIN, Role.SUPER_MANAGER].sort(),
    );
  });

  it("switches the organisation in view, never another's; on all organisations, pick one first", async () => {
    const store = { read: jest.fn(async () => null), write: jest.fn(async () => undefined) };
    const repo = {
      integrationPeriods: jest.fn(async () => []),
      switchIntegration: jest.fn(async () => true),
    };
    const settings = new BiometricSettingsService(store as never, repo as never);
    const controller = new BiometricController({} as never, {} as never, settings, {} as never);
    await controller.patchSettings(actor('sa', Role.SUPER_ADMIN, ORG_B), { integrationOn: true });
    expect(repo.switchIntegration.mock.calls[0]).toEqual(
      expect.arrayContaining([ORG_B, true, 'sa']),
    );
    expect(repo.integrationPeriods).toHaveBeenCalledWith(ORG_B);
    await expect(
      controller.patchSettings(actor('sa', Role.SUPER_ADMIN, null), { integrationOn: true }),
    ).rejects.toMatchObject({ code: 'ORG_REQUIRED' });
    expect(repo.switchIntegration).toHaveBeenCalledTimes(1);
  });

  it("the status shows the organisation's own switch to its readers, and refuses the rest", async () => {
    const repo = {
      stats: jest.fn(async () => ({
        lastPunchAt: null,
        lastReceivedAt: null,
        today: 0,
        unmatched: 0,
      })),
      people: jest.fn(async () => []),
    };
    const settings = {
      pullState: jest.fn(async () => ({})),
      get: jest.fn(async () => biometricFromStored(null)),
      integration: jest.fn(async (companyId: string) => ({ on: companyId === ORG_B, periods: [] })),
    };
    const svc = new BiometricAdminService(
      repo as never,
      {} as never,
      {} as never,
      { list: jest.fn(async () => []) } as never,
      settings as never,
    );
    await expect(svc.status(actor('admin-b', Role.ADMIN, ORG_B), NOW)).resolves.toMatchObject({
      integrationOn: true,
    });
    await expect(svc.status(actor('sm', Role.SUPER_MANAGER, ORG_A), NOW)).resolves.toMatchObject({
      integrationOn: false,
    });
    expect(settings.integration.mock.calls.map((c) => c[0])).toEqual([ORG_B, ORG_A]);
    await expect(svc.status(actor('m', Role.MANAGER), NOW)).rejects.toMatchObject({
      status: 403,
    });
  });
});
