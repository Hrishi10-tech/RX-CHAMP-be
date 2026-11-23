import { BiometricSettingsService } from './biometric-settings.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const NOW = new Date('2026-11-05T06:30:00Z'); // 12:00 in India, 5 November.
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function setup() {
  const store = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
  };
  const repo = {
    integrationPeriods: jest.fn().mockResolvedValue([]),
    switchIntegration: jest.fn().mockResolvedValue(true),
  };
  return { svc: new BiometricSettingsService(store as never, repo as never), store, repo };
}

describe('the integration switch (3.6), one per organisation (4.0)', () => {
  it("is off until the organisation's admin turns it on", async () => {
    const { svc, repo } = setup();
    await expect(svc.view(ORG_A)).resolves.toMatchObject({
      integrationOn: false,
      integrationPeriods: [],
    });
    expect(repo.integrationPeriods).toHaveBeenCalledWith(ORG_A);
  });

  it('on: a period of that organisation from today, by whoever switched it', async () => {
    const { svc, repo } = setup();
    const res = await svc.update(ORG_A, { integrationOn: true }, 'admin-a', NOW);
    expect(repo.switchIntegration).toHaveBeenCalledWith(ORG_A, true, '2026-11-05', NOW, 'admin-a');
    expect(res.changed).toEqual(['integrationOn']);
  });

  it("off: closes that organisation's period today, and only that one", async () => {
    const { svc, repo } = setup();
    await svc.update(ORG_B, { integrationOn: false }, 'admin-b', NOW);
    expect(repo.switchIntegration).toHaveBeenCalledTimes(1);
    expect(repo.switchIntegration).toHaveBeenCalledWith(ORG_B, false, '2026-11-05', NOW, 'admin-b');
  });

  it('asking for what it already is changes nothing', async () => {
    const { svc, repo } = setup();
    repo.switchIntegration.mockResolvedValue(false);
    expect((await svc.update(ORG_A, { integrationOn: true }, 'admin-a', NOW)).changed).toEqual([]);
  });

  it('anything but on or off is refused, and a bad patch never reaches the switch', async () => {
    const { svc, repo } = setup();
    await expect(svc.update(ORG_A, { integrationOn: 'yes' }, 'admin-a', NOW)).rejects.toMatchObject(
      {
        status: 400,
        details: { field: 'integrationOn' },
      },
    );
    await expect(
      svc.update(ORG_A, { integrationOn: true, gapRule: 'NOPE' }, 'admin-a', NOW),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.switchIntegration).not.toHaveBeenCalled();
  });

  it('other settings save without touching the switch', async () => {
    const { svc, repo } = setup();
    await svc.update(ORG_A, { gapRule: 'PAIRS' }, 'admin-a', NOW);
    expect(repo.switchIntegration).not.toHaveBeenCalled();
  });

  it("each organisation reads its own history: another's open period never shows it on", async () => {
    const { svc, repo } = setup();
    repo.integrationPeriods.mockImplementation(async (companyId: string) =>
      companyId === ORG_B
        ? [
            {
              id: 'b',
              fromDate: '2026-11-01',
              toDate: null,
              startedAt: NOW,
              endedAt: null,
              startedByName: 'Admin B',
              endedByName: null,
            },
          ]
        : [],
    );
    expect((await svc.integration(ORG_A)).on).toBe(false);
    expect((await svc.integration(ORG_B)).on).toBe(true);
  });

  it('shows the history, newest first, as the repository gives it', async () => {
    const { svc, repo } = setup();
    repo.integrationPeriods.mockResolvedValue([
      {
        id: 'b',
        fromDate: '2026-11-05',
        toDate: null,
        startedAt: NOW,
        endedAt: null,
        startedByName: 'Meera Nair',
        endedByName: null,
      },
      {
        id: 'a',
        fromDate: '2026-09-01',
        toDate: '2026-09-10',
        startedAt: new Date('2026-09-01T04:00:00Z'),
        endedAt: new Date('2026-09-10T04:00:00Z'),
        startedByName: 'Meera Nair',
        endedByName: 'Former user',
      },
    ]);
    await expect(svc.integration(ORG_A)).resolves.toEqual({
      on: true,
      periods: [
        {
          fromDate: '2026-11-05',
          toDate: null,
          startedAt: NOW.toISOString(),
          endedAt: null,
          startedByName: 'Meera Nair',
          endedByName: null,
        },
        {
          fromDate: '2026-09-01',
          toDate: '2026-09-10',
          startedAt: '2026-09-01T04:00:00.000Z',
          endedAt: '2026-09-10T04:00:00.000Z',
          startedByName: 'Meera Nair',
          endedByName: 'Former user',
        },
      ],
    });
  });
});
