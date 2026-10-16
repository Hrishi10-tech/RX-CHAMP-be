import { LoginAttempts } from './login-attempts.service';

describe('LoginAttempts', () => {
  it('locks an account after repeated failures and unlocks after the pause', () => {
    const a = new LoginAttempts();
    const t0 = 1_000_000;
    for (let i = 0; i < LoginAttempts.MAX_FAILURES - 1; i++) a.recordFailure('Jane@X.test', t0 + i);
    expect(() => a.assertAllowed('jane@x.test', t0 + 100)).not.toThrow();
    a.recordFailure('jane@x.test', t0 + 200);
    expect(() => a.assertAllowed('JANE@x.test', t0 + 300)).toThrow(/paused for 15 minutes/);
    expect(() =>
      a.assertAllowed('jane@x.test', t0 + 200 + LoginAttempts.LOCK_MS + 1),
    ).not.toThrow();
  });

  it('forgets failures after a success or once the window passes', () => {
    const a = new LoginAttempts();
    for (let i = 0; i < LoginAttempts.MAX_FAILURES - 1; i++) a.recordFailure('a@x.test', i);
    a.recordSuccess('a@x.test');
    a.recordFailure('a@x.test', 100);
    expect(() => a.assertAllowed('a@x.test', 200)).not.toThrow();

    const b = new LoginAttempts();
    for (let i = 0; i < LoginAttempts.MAX_FAILURES - 1; i++) b.recordFailure('b@x.test', i);
    b.recordFailure('b@x.test', LoginAttempts.WINDOW_MS + 10);
    expect(() => b.assertAllowed('b@x.test', LoginAttempts.WINDOW_MS + 20)).not.toThrow();
  });

  it('keeps accounts apart', () => {
    const a = new LoginAttempts();
    for (let i = 0; i < LoginAttempts.MAX_FAILURES; i++) a.recordFailure('x@x.test', i);
    expect(() => a.assertAllowed('y@x.test', 100)).not.toThrow();
  });
});
