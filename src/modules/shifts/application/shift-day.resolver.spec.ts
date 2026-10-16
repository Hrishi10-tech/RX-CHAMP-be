import { ShiftDayResolver } from './shift-day.resolver';

describe('ShiftDayResolver', () => {
  const at = new Date('2026-10-14T20:00:00Z'); // 01:30 on the 15th in India
  const setup = (people: { id: string }[]) => {
    const reader = { findAnyByIds: jest.fn().mockResolvedValue(people) };
    const days = {
      context: jest.fn().mockResolvedValue({ ctx: true }),
      // A night shift: the early hours belong to the evening before.
      dayWith: jest.fn().mockReturnValue({ dateKey: '2026-10-14' }),
    };
    return { resolver: new ShiftDayResolver(reader as never, days as never), reader, days };
  };

  it("a person's shift-day; the calendar day for someone unknown", async () => {
    const { resolver, days } = setup([{ id: 'u1' }]);
    expect(await resolver.dayKeyAt('u1', at)).toBe('2026-10-14');
    expect(days.dayWith).toHaveBeenCalledWith({ ctx: true }, { id: 'u1' }, at);
    const nobody = setup([]);
    expect(await nobody.resolver.dayKeyAt('ghost', at)).toBe('2026-10-15');
    expect(nobody.days.context).not.toHaveBeenCalled();
  });

  it('one lookup, then a pure key function', async () => {
    const { resolver, reader } = setup([{ id: 'u1' }]);
    const dayOf = await resolver.keyFnFor('u1');
    dayOf(at);
    dayOf(new Date());
    expect(reader.findAnyByIds).toHaveBeenCalledTimes(1);
  });

  it('reads each person at most once a minute (the presence poll)', async () => {
    const { resolver, reader, days } = setup([{ id: 'u1' }]);
    for (let i = 0; i < 5; i++) await resolver.dayKeysAt(['u1'], at);
    await resolver.dayKeyAt('u1', at);
    expect(reader.findAnyByIds).toHaveBeenCalledTimes(1);
    // An unknown id is remembered too (calendar day, no new lookup).
    await resolver.dayKeysAt(['ghost'], at);
    await resolver.dayKeysAt(['ghost'], at);
    expect(reader.findAnyByIds).toHaveBeenCalledTimes(2);
    expect(days.context).toHaveBeenCalled();
  });

  it('many people at once: shift-day where known, calendar day otherwise', async () => {
    const { resolver, reader } = setup([{ id: 'u1' }]);
    const keys = await resolver.dayKeysAt(['u1', 'u2', 'u1'], at);
    expect(reader.findAnyByIds).toHaveBeenCalledWith(['u1', 'u2']);
    expect(Object.fromEntries(keys)).toEqual({ u1: '2026-10-14', u2: '2026-10-15' });
  });
});
