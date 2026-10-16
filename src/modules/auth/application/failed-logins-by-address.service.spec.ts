import { FailedLoginsByAddress, failedLoginLimits } from './failed-logins-by-address.service';

describe('FailedLoginsByAddress', () => {
  const T0 = Date.UTC(2026, 9, 14, 4, 0);
  const MIN = 60_000;

  it('blocks an address at 30 failures within 10 minutes, for what is left of the window', () => {
    const f = new FailedLoginsByAddress();
    for (let i = 0; i < 29; i++) f.recordFailure('10.0.0.1', T0 + i * 1000);
    expect(f.blockedForMin('10.0.0.1', T0 + 30_000)).toBe(0);
    f.recordFailure('10.0.0.1', T0 + 30_000);
    expect(f.blockedForMin('10.0.0.1', T0 + 30_000)).toBe(10);
    expect(f.blockedForMin('10.0.0.1', T0 + 9 * MIN)).toBe(1);
    // The first failure leaves the window: under the limit again.
    expect(f.blockedForMin('10.0.0.1', T0 + 10 * MIN)).toBe(0);
    expect(f.blockedForMin('10.0.0.2', T0 + 30_000)).toBe(0);
  });

  it('failures spread over more than 10 minutes never block', () => {
    const f = new FailedLoginsByAddress();
    for (let i = 0; i < 60; i++) f.recordFailure('10.0.0.1', T0 + i * 21_000);
    expect(f.blockedForMin('10.0.0.1', T0 + 60 * 21_000)).toBe(0);
  });

  it('a request with no address is never counted or blocked', () => {
    const f = new FailedLoginsByAddress();
    for (let i = 0; i < 40; i++) f.recordFailure(null, T0);
    expect(f.blockedForMin(null, T0)).toBe(0);
  });
});

describe('failedLoginLimits', () => {
  it('uses the defaults when nothing or nonsense is set', () => {
    expect(failedLoginLimits({})).toEqual({ maxFailures: 30, windowMs: 600_000 });
    expect(
      failedLoginLimits({ LOGIN_FAILED_PER_IP_MAX: 'lots', LOGIN_FAILED_PER_IP_WINDOW_MIN: '0' }),
    ).toEqual({ maxFailures: 30, windowMs: 600_000 });
    expect(failedLoginLimits({ LOGIN_FAILED_PER_IP_MAX: '4' }).maxFailures).toBe(30);
  });

  it('takes values inside the bounds', () => {
    expect(
      failedLoginLimits({ LOGIN_FAILED_PER_IP_MAX: '120', LOGIN_FAILED_PER_IP_WINDOW_MIN: '15' }),
    ).toEqual({ maxFailures: 120, windowMs: 900_000 });
  });

  it('applies them to the limiter', () => {
    const before = process.env.LOGIN_FAILED_PER_IP_MAX;
    process.env.LOGIN_FAILED_PER_IP_MAX = '5';
    try {
      const f = new FailedLoginsByAddress();
      for (let i = 0; i < 4; i++) f.recordFailure('10.0.0.9', 1_000 + i);
      expect(f.blockedForMin('10.0.0.9', 2_000)).toBe(0);
      f.recordFailure('10.0.0.9', 1_500);
      expect(f.blockedForMin('10.0.0.9', 2_000)).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.LOGIN_FAILED_PER_IP_MAX;
      else process.env.LOGIN_FAILED_PER_IP_MAX = before;
    }
  });
});
