import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { ChangePasswordUseCase } from './change-password.use-case';

const me = { id: 'u1' } as never;
const meta = { userAgent: 'jest', ip: '127.0.0.1' };

function setup() {
  const user = {
    id: 'u1',
    email: 'a@b.test',
    role: 'USER',
    passwordHash: 'old-hash',
    isActive: () => true,
    setPasswordHash: jest.fn(),
  };
  const users = {
    findById: jest.fn().mockResolvedValue(user),
    save: jest.fn().mockResolvedValue(user),
    raiseAuthEpoch: jest.fn().mockResolvedValue(3),
    authEpochOf: jest.fn().mockResolvedValue(3),
  };
  const hasher = {
    compare: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('new-hash'),
  };
  const tokens = { signAccessToken: jest.fn().mockResolvedValue('access') };
  const refreshTokens = {
    revokeAllForUser: jest.fn().mockResolvedValue(2),
    issue: jest.fn().mockResolvedValue({ token: 'refresh' }),
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const useCase = new ChangePasswordUseCase(
    users as never,
    hasher as never,
    tokens as never,
    refreshTokens as never,
    events as never,
  );
  return { useCase, users, refreshTokens, events };
}

describe('ChangePasswordUseCase: the other devices (3.6)', () => {
  it('asked to sign them out: their sessions end and their phones are told to go', async () => {
    const { useCase, users, refreshTokens, events } = setup();
    await useCase.execute(me, 'old-password', 'new-password', true, meta);
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u1');
    expect(users.raiseAuthEpoch).toHaveBeenCalledWith('u1');
    expect(events.publish).toHaveBeenCalledTimes(1);
    const [name, event] = events.publish.mock.calls[0] as [string, OtherDevicesSignedOutEvent];
    expect(name).toBe(OtherDevicesSignedOutEvent.eventName);
    expect(event.userId).toBe('u1');
  });

  it('the event goes out only once this device has its new session', async () => {
    const { useCase, refreshTokens, events } = setup();
    await useCase.execute(me, 'old-password', 'new-password', true, meta);
    expect(refreshTokens.issue.mock.invocationCallOrder[0]).toBeLessThan(
      events.publish.mock.invocationCallOrder[0],
    );
  });

  it('not asked: nothing happens to them', async () => {
    const { useCase, users, refreshTokens, events } = setup();
    await useCase.execute(me, 'old-password', 'new-password', false, meta);
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    expect(users.raiseAuthEpoch).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('the new session on this device still comes back', async () => {
    const { useCase, refreshTokens } = setup();
    await expect(useCase.execute(me, 'old-password', 'new-password', true, meta)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(refreshTokens.issue).toHaveBeenCalledTimes(1);
  });
});
