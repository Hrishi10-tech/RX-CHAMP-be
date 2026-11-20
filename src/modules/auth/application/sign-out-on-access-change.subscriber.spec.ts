import { UserAccessChange, UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { SignOutOnAccessChangeSubscriber } from './sign-out-on-access-change.subscriber';

function setup() {
  const refreshTokens = { revokeAllForUser: jest.fn().mockResolvedValue(1) };
  const users = { raiseAuthEpoch: jest.fn().mockResolvedValue(undefined) };
  const events = { subscribe: jest.fn(), publish: jest.fn() };
  const subscriber = new SignOutOnAccessChangeSubscriber(
    events as never,
    refreshTokens as never,
    users as never,
  );
  const fire = (changes: UserAccessChange[], active?: boolean) =>
    subscriber.handle(new UserAccessChangedEvent('u-1', changes, new Date(), active));
  return { subscriber, refreshTokens, users, events, fire };
}

/**
 * F-02, F-03, F-12: the auth epoch is what ends access tokens, socket tickets and
 * enrollment tokens. It moves on every change that must end them; refresh tokens
 * are revoked only where the person has to sign in again.
 */
describe('SignOutOnAccessChangeSubscriber', () => {
  it('listens for access changes', () => {
    const { subscriber, events } = setup();
    subscriber.onModuleInit();
    expect(events.subscribe).toHaveBeenCalledWith(
      UserAccessChangedEvent.eventName,
      expect.any(Function),
    );
  });

  it.each<[string, UserAccessChange[], boolean | undefined]>([
    ['sign out everywhere', ['PASSWORD', 'SIGN_OUT'], true],
    ['a delete', ['DELETED'], false],
    ['a block', ['STATUS'], false],
  ])('%s: raises the epoch and revokes the refresh tokens', async (_name, changes, active) => {
    const { fire, users, refreshTokens } = setup();
    await fire(changes, active);
    expect(users.raiseAuthEpoch).toHaveBeenCalledTimes(1);
    expect(users.raiseAuthEpoch).toHaveBeenCalledWith('u-1');
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u-1');
  });

  it.each<[string, UserAccessChange[], boolean | undefined]>([
    ['a role change', ['ROLE'], undefined],
    ['a manager change', ['MANAGER'], undefined],
    ['an unblock', ['STATUS'], true],
    ['a re-added account (reactivation)', ['MANAGER', 'ROLE'], true],
  ])('%s: raises the epoch once and leaves the refresh tokens', async (_name, changes, active) => {
    const { fire, users, refreshTokens } = setup();
    await fire(changes, active);
    expect(users.raiseAuthEpoch).toHaveBeenCalledTimes(1);
    expect(users.raiseAuthEpoch).toHaveBeenCalledWith('u-1');
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('a password set by an administrator without "sign out everywhere" ends nothing', async () => {
    const { fire, users, refreshTokens } = setup();
    await fire(['PASSWORD'], true);
    expect(users.raiseAuthEpoch).not.toHaveBeenCalled();
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('raises the epoch before it revokes, so a token already out is refused first', async () => {
    const { fire, users, refreshTokens } = setup();
    const order: string[] = [];
    users.raiseAuthEpoch.mockImplementation(async () => void order.push('epoch'));
    refreshTokens.revokeAllForUser.mockImplementation(async () => order.push('revoke'));
    await fire(['SIGN_OUT'], true);
    expect(order).toEqual(['epoch', 'revoke']);
  });

  it('still revokes the refresh tokens when the epoch could not be raised', async () => {
    const { fire, users, refreshTokens } = setup();
    users.raiseAuthEpoch.mockRejectedValue(new Error('db down'));

    await expect(fire(['SIGN_OUT'], true)).rejects.toThrow('db down');
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u-1');
  });
});
