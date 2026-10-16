import { BreakDayService, CONTEXT_TTL_MS } from './break-day.service';

const shift = (id: string, isDefault = false) => ({ id, isDefault }) as never;
const row = (over: Record<string, unknown>) =>
  ({ target: 'USER', userId: null, departmentKey: null, ...over }) as never;

function setup() {
  const repo = {
    list: jest.fn().mockResolvedValue([shift('general', true), shift('night')]),
    listAllAssignments: jest
      .fn()
      .mockResolvedValue([
        row({ id: 'd1', target: 'DEPARTMENT', departmentKey: 'billing' }),
        row({ id: 'u1', userId: 'u1' }),
        row({ id: 'u2', userId: 'u2' }),
      ]),
  };
  return { svc: new BreakDayService(repo as never), repo };
}

describe('BreakDayService resolution context', () => {
  afterEach(() => jest.useRealTimers());

  it('department rows for everyone, personal rows only for the people asked about', async () => {
    const { svc } = setup();
    const ctx = await svc.context(['u1']);
    expect(ctx.assignments.map((a) => a.id)).toEqual(['d1', 'u1']);
    expect(ctx.defaults.map((s) => s.id)).toEqual(['general']);
    expect([...ctx.shiftsById.keys()]).toEqual(['general', 'night']);
  });

  it('reads shifts and assignments once a minute at most (the presence poll)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-14T06:00:00Z'));
    const { svc, repo } = setup();
    for (let i = 0; i < 12; i++) await svc.context([i % 2 ? 'u1' : 'u2']);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.listAllAssignments).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(Date.now() + CONTEXT_TTL_MS));
    await svc.context(['u1']);
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('a change to a shift or an assignment is seen at once (invalidate)', async () => {
    const { svc, repo } = setup();
    await svc.context(['u1']);
    repo.list.mockResolvedValue([shift('general', true)]);
    svc.invalidate();
    expect([...(await svc.context(['u1'])).shiftsById.keys()]).toEqual(['general']);
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not kept', async () => {
    const { svc, repo } = setup();
    repo.list.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.context(['u1'])).rejects.toThrow('db down');
    await expect(svc.context(['u1'])).resolves.toBeDefined();
    expect(repo.list).toHaveBeenCalledTimes(2);
  });
});
