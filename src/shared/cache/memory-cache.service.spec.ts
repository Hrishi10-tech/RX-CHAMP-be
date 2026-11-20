import { MemoryCacheService } from './memory-cache.service';

/** The entries the service is holding, read without going through `get` (which evicts). */
const held = (cache: MemoryCacheService) =>
  (cache as unknown as { store: Map<string, unknown> }).store;
const sweeper = (cache: MemoryCacheService) =>
  (cache as unknown as { sweeper: NodeJS.Timeout | null }).sweeper;

describe('MemoryCacheService', () => {
  let cache: MemoryCacheService;
  beforeEach(() => {
    jest.useFakeTimers();
    cache = new MemoryCacheService();
  });
  afterEach(() => {
    cache.onModuleDestroy();
    jest.useRealTimers();
  });

  it('answers a value until its time is up, and nothing after', async () => {
    await cache.set('k', { n: 1 }, 30);
    await expect(cache.get('k')).resolves.toEqual({ n: 1 });

    jest.setSystemTime(Date.now() + 30_000);
    await expect(cache.get('k')).resolves.toBeNull();
    expect(held(cache).has('k')).toBe(false);
  });

  // F-11: a refresh-rotation replay entry is never read after its grace, so reading
  // cannot be what removes it.
  it('drops expired entries that are never read again', async () => {
    for (let i = 0; i < 500; i += 1) await cache.set(`refresh:replay:${i}`, { token: 't' }, 1);
    expect(held(cache).size).toBe(500);

    jest.advanceTimersByTime(31_000);

    expect(held(cache).size).toBe(0);
  });

  it('sweeps only what has expired: a longer entry and one with no time limit stay', async () => {
    await cache.set('short', 1, 1);
    await cache.set('long', 2, 3_600);
    await cache.set('forever', 3);

    jest.advanceTimersByTime(31_000);

    expect([...held(cache).keys()]).toEqual(['long', 'forever']);
    await expect(cache.get('long')).resolves.toBe(2);
    await expect(cache.get('forever')).resolves.toBe(3);
  });

  it('runs no timer until something can expire, and stops once nothing can', async () => {
    await cache.set('forever', 1);
    expect(sweeper(cache)).toBeNull();

    await cache.set('short', 1, 1);
    expect(sweeper(cache)).not.toBeNull();

    jest.advanceTimersByTime(31_000);
    expect(sweeper(cache)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);

    // And starts again with the next entry that can expire.
    await cache.set('again', 1, 1);
    jest.advanceTimersByTime(31_000);
    expect(held(cache).has('again')).toBe(false);
  });

  it('never keeps the process alive', async () => {
    jest.useRealTimers();
    await cache.set('short', 1, 1);
    expect(sweeper(cache)!.hasRef()).toBe(false);
  });

  it('keeps del and delByPattern as they were', async () => {
    await cache.set('a:1', 1, 60);
    await cache.set('a:2', 2, 60);
    await cache.set('b:1', 3, 60);

    await cache.del('a:1');
    await cache.delByPattern('a:*');

    expect([...held(cache).keys()]).toEqual(['b:1']);
  });
});
