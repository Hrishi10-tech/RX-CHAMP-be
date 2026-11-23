import { DEFAULT_REASON_PRESETS, REASON_PRESETS_KEY } from '../domain/reason-presets';
import { ReasonPresetsService } from './reason-presets.service';

function setup(stored: unknown) {
  let row = stored;
  const store = {
    read: jest.fn(async () => row),
    write: jest.fn(async (_key: string, value: unknown) => {
      row = value;
    }),
  };
  return { store, row: () => row, svc: new ReasonPresetsService(store as never) };
}

describe('ReasonPresetsService: saving one list', () => {
  it('stores that list alone, and the others go on following the defaults', async () => {
    const { store, svc } = setup(null);
    const view = await svc.update({ LEAVE_REASON: ['Family function'] }, 'sa');
    expect(store.write).toHaveBeenCalledWith(
      REASON_PRESETS_KEY,
      { LEAVE_REASON: ['Family function'] },
      'sa',
    );
    expect(view.presets.LEAVE_REASON).toEqual(['Family function']);
    expect(view.presets.SKIP_COMMENT).toEqual(DEFAULT_REASON_PRESETS.SKIP_COMMENT);
  });

  it('a row an earlier release saved: the answer has the new words, the row its old ones', async () => {
    const old = {
      SKIP_COMMENT: ['On a client call', 'In a meeting', 'Deadline', 'Forgot to take it'],
      LEAVE_REASON: ['Family function'],
    };
    const { row, svc } = setup(old);
    expect((await svc.get()).SKIP_COMMENT).toContain('Busy at the time');
    const view = await svc.update({ WFH_REASON: ['Delivery at home'] }, 'sa');
    expect(view.presets.SKIP_COMMENT).toContain('Busy at the time');
    expect(view.presets.LEAVE_REASON).toEqual(['Family function']);
    expect(row()).toEqual({ ...old, WFH_REASON: ['Delivery at home'] });
  });

  it('Defaults (null) takes the list out of the row', async () => {
    const { row, svc } = setup({ LEAVE_REASON: ['Family function'] });
    const view = await svc.update({ LEAVE_REASON: null }, 'sa');
    expect(row()).toEqual({});
    expect(view.presets.LEAVE_REASON).toEqual(DEFAULT_REASON_PRESETS.LEAVE_REASON);
  });

  it('a refused patch writes nothing', async () => {
    const { store, svc } = setup(null);
    await expect(svc.update({ NOPE: [] }, 'sa')).rejects.toMatchObject({
      status: 400,
      details: { field: 'NOPE' },
    });
    expect(store.write).not.toHaveBeenCalled();
  });
});
