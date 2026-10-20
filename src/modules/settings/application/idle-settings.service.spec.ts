import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { BUILT_IN_REASONS } from '../domain/idle.rules';
import { IdleSettingsService } from './idle-settings.service';

const ORG = '00000000-0000-0000-0000-0000000000c1';
const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';

function setup(initial: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = { ...initial };
  const settings = {
    readRaw: jest.fn(async () => row),
    writeRaw: jest.fn(async (_c: string, patch: Record<string, unknown>) => {
      // Simulates a slow database so overlapping writes would interleave.
      await new Promise((r) => setTimeout(r, 5));
      row = { ...row, ...patch };
      return row;
    }),
  };
  const prisma = {
    department: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; companyId: string } }) =>
        [D1, D2].includes(where.id) && where.companyId === ORG ? { id: where.id } : null,
      ),
      findMany: jest.fn(async () => [
        { id: D1, name: 'Electronics', icon: 'circuit-board' },
        { id: D2, name: 'Sales', icon: 'bar-chart' },
      ]),
    },
  };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const service = new IdleSettingsService(settings as any, prisma as any, events as any);
  return { service, settings, prisma, events, row: () => row };
}

describe('IdleSettingsService', () => {
  it('lists every department with nulls when it follows the organisation', async () => {
    const { service } = setup({
      departmentIdle: { [D1]: { enabled: true, minutes: 7, reasonKeys: null } },
    });
    const view = await service.get(ORG);
    expect(view.defaultEnabled).toBe(false);
    expect(view.defaultMinutes).toBe(5);
    expect(view.reasons.map((r) => r.key)).toEqual(BUILT_IN_REASONS.map((b) => b.key));
    expect(view.departments).toEqual([
      {
        departmentId: D1,
        name: 'Electronics',
        icon: 'circuit-board',
        enabled: true,
        minutes: 7,
        reasonKeys: null,
      },
      {
        departmentId: D2,
        name: 'Sales',
        icon: 'bar-chart',
        enabled: null,
        minutes: null,
        reasonKeys: null,
      },
    ]);
  });

  it('saves the default and new reasons and tells agents (IDLE)', async () => {
    const { service, events, row } = setup();
    const reasons = [
      ...BUILT_IN_REASONS.map((b) => ({ key: b.key, label: b.label })),
      { key: null, label: 'Soldering' },
    ];
    const view = await service.update(
      ORG,
      { defaultEnabled: true, defaultMinutes: 8, reasons },
      'admin-1',
    );
    expect(row()).toMatchObject({ idleDefaultEnabled: true, idleDefaultMinutes: 8 });
    expect(view.reasons.at(-1)).toEqual({
      key: 'C_SOLDERING',
      label: 'Soldering',
      kind: 'CUSTOM',
      builtIn: false,
    });
    const [name, event] = events.publish.mock.calls[0];
    expect(name).toBe(OrgConfigChangedEvent.eventName);
    expect(event).toMatchObject({ companyId: ORG, kind: 'IDLE' });
  });

  it('refuses out-of-range minutes before writing anything', async () => {
    const { service, settings } = setup();
    await expect(
      service.update(ORG, { defaultEnabled: true, defaultMinutes: 61 }, 'a'),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(settings.writeRaw).not.toHaveBeenCalled();
  });

  it('removing a custom reason drops it from departments that chose it', async () => {
    const { service, row } = setup({
      idleReasons: [{ key: 'C_LAB', label: 'Lab', kind: 'CUSTOM' }],
      departmentIdle: { [D1]: { enabled: null, minutes: null, reasonKeys: ['BREAK', 'C_LAB'] } },
    });
    await service.update(
      ORG,
      {
        defaultEnabled: false,
        defaultMinutes: 5,
        reasons: BUILT_IN_REASONS.map((b) => ({ key: b.key, label: b.label })),
      },
      'a',
    );
    expect((row().departmentIdle as any)[D1].reasonKeys).toEqual(['BREAK']);
  });

  it('answers 404 for a department of another organisation', async () => {
    const { service } = setup();
    await expect(
      service.updateDepartment(ORG, '00000000-0000-0000-0000-0000000000ff', { enabled: true }, 'a'),
    ).rejects.toMatchObject({ status: 404, code: 'DEPARTMENT_NOT_FOUND' });
  });

  it('clears the entry when every field goes back to null', async () => {
    const { service, row } = setup({
      departmentIdle: { [D1]: { enabled: true, minutes: null, reasonKeys: null } },
    });
    await service.updateDepartment(
      ORG,
      D1,
      { enabled: null, minutes: null, reasonKeys: null },
      'a',
    );
    expect(row().departmentIdle).toEqual({});
  });

  it('never loses an entry when two departments are saved at once', async () => {
    const { service, row } = setup();
    await Promise.all([
      service.updateDepartment(ORG, D1, { enabled: true }, 'a'),
      service.updateDepartment(ORG, D2, { minutes: 12 }, 'a'),
    ]);
    expect(Object.keys(row().departmentIdle as object).sort()).toEqual([D1, D2]);
  });

  it('removes a deleted department entry', async () => {
    const { service, row } = setup({
      departmentIdle: { [D1]: { enabled: true, minutes: null, reasonKeys: null } },
    });
    await service.removeDepartment(ORG, D1, 'a');
    expect(row().departmentIdle).toEqual({});
  });
});
