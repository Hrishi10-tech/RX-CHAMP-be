import { Logger } from '@nestjs/common';
import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { PushDelivery, PushPayload, PushProvider } from '../domain/push-provider';
import { PushRepository } from '../domain/push.repository';
import { PushService } from './push.service';

const TOKEN_A = 'device-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'device-token-bbbbbbbbbbbbbbbbbbbbbbbb';
const message = {
  recipientId: 'm1',
  title: 'A leave request is waiting for you',
  body: 'Open RX Vision to review it.',
  data: { type: 'APPROVAL_REQUEST', what: 'LEAVE', id: 'l1' },
};

function setup(
  opts: {
    flag?: boolean;
    configured?: boolean;
    devices?: string[];
    answers?: Record<string, PushDelivery>;
    accessTtl?: string;
  } = {},
) {
  const repo: jest.Mocked<PushRepository> = {
    saveDevice: jest.fn().mockResolvedValue(undefined),
    removeDevices: jest.fn().mockResolvedValue(1),
    removeToken: jest.fn().mockResolvedValue(undefined),
    devicesOf: jest
      .fn()
      .mockResolvedValue((opts.devices ?? []).map((token) => ({ token, platform: 'android' }))),
    record: jest.fn().mockResolvedValue({ id: 'row-1' }),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  const deliver = jest.fn(
    async (token: string, _payload: PushPayload): Promise<PushDelivery> =>
      opts.answers?.[token] ?? { ok: true },
  );
  const provider: PushProvider = { configured: opts.configured ?? true, deliver };
  const handlers = new Map<string, (e: unknown) => unknown>();
  const events = {
    publish: jest.fn(),
    subscribe: jest.fn((name: string, h: (e: unknown) => unknown) => handlers.set(name, h)),
  };
  const features = { isOn: jest.fn().mockReturnValue(opts.flag ?? true) };
  const config = { get: jest.fn().mockReturnValue(opts.accessTtl ?? '15m') };
  const service = new PushService(
    repo,
    provider,
    events as never,
    features as never,
    config as never,
  );
  return { service, repo, deliver, features, handlers };
}

describe('PushService (3.6)', () => {
  it('flag off: writes the row and calls nobody', async () => {
    const { service, repo, deliver, features } = setup({ flag: false, devices: [TOKEN_A] });
    await expect(service.send(message)).resolves.toBe('NOT_SENT');
    expect(features.isOn).toHaveBeenCalledWith('mobilePush');
    expect(repo.record).toHaveBeenCalledWith(message);
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.devicesOf).not.toHaveBeenCalled();
    expect(repo.settle).not.toHaveBeenCalled();
  });

  it('flag on but no credentials: writes the row and calls nobody', async () => {
    const { service, repo, deliver } = setup({ configured: false, devices: [TOKEN_A] });
    await expect(service.send(message)).resolves.toBe('NOT_SENT');
    expect(repo.record).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('nobody registered: settles NO_DEVICE', async () => {
    const { service, repo, deliver } = setup();
    await expect(service.send(message)).resolves.toBe('NO_DEVICE');
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.settle).toHaveBeenCalledWith('row-1', {
      sentState: 'NO_DEVICE',
      devices: 0,
      delivered: 0,
      errorCode: null,
      sentAt: null,
    });
  });

  it('sends to every device of the person and settles SENT', async () => {
    const { service, repo, deliver } = setup({ devices: [TOKEN_A, TOKEN_B] });
    await expect(service.send(message)).resolves.toBe('SENT');
    expect(deliver.mock.calls.map(([t]) => t).sort()).toEqual([TOKEN_A, TOKEN_B]);
    expect(deliver.mock.calls[0][1]).toEqual({
      title: message.title,
      body: message.body,
      data: message.data,
    });
    expect(repo.settle).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ sentState: 'SENT', devices: 2, delivered: 2, errorCode: null }),
    );
    expect(repo.settle.mock.calls[0][1].sentAt).toBeInstanceOf(Date);
  });

  it('writes the row before it tries anything', async () => {
    const order: string[] = [];
    const { service, repo, deliver } = setup({ devices: [TOKEN_A] });
    repo.record.mockImplementation(async () => {
      order.push('record');
      return { id: 'row-1' };
    });
    deliver.mockImplementation(async () => {
      order.push('deliver');
      return { ok: true };
    });
    await service.send(message);
    expect(order).toEqual(['record', 'deliver']);
  });

  it('forgets a dead token and still counts the phone that took it', async () => {
    const { service, repo } = setup({
      devices: [TOKEN_A, TOKEN_B],
      answers: { [TOKEN_A]: { ok: false, code: 'UNREGISTERED' } },
    });
    await expect(service.send(message)).resolves.toBe('SENT');
    expect(repo.removeToken).toHaveBeenCalledWith(TOKEN_A);
    expect(repo.removeToken).toHaveBeenCalledTimes(1);
    expect(repo.settle).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ sentState: 'SENT', devices: 2, delivered: 1 }),
    );
  });

  it('settles FAILED with a short code when no phone took it', async () => {
    const { service, repo } = setup({
      devices: [TOKEN_A],
      answers: { [TOKEN_A]: { ok: false, code: 'UNAVAILABLE' } },
    });
    await expect(service.send(message)).resolves.toBe('FAILED');
    expect(repo.removeToken).not.toHaveBeenCalled();
    expect(repo.settle).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({
        sentState: 'FAILED',
        devices: 1,
        delivered: 0,
        errorCode: 'UNAVAILABLE',
        sentAt: null,
      }),
    );
  });

  it('never throws, and never logs a token', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, repo } = setup({ devices: [TOKEN_A] });
    repo.record.mockRejectedValueOnce(new Error(`row with ${TOKEN_A}`));
    await expect(service.send(message)).resolves.toBe('FAILED');
    repo.devicesOf.mockRejectedValueOnce(new Error(`device ${TOKEN_A}`));
    await expect(service.send(message)).resolves.toBe('FAILED');
    expect(repo.settle).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ sentState: 'FAILED', errorCode: 'ERROR' }),
    );
    repo.devicesOf.mockRejectedValueOnce(new Error('again'));
    repo.settle.mockRejectedValueOnce(new Error('and the row too'));
    await expect(service.send(message)).resolves.toBe('FAILED');
    const logged = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(logged).not.toContain(TOKEN_A);
    warn.mockRestore();
  });

  it('a message with no data sends an empty map', async () => {
    const { service, deliver } = setup({ devices: [TOKEN_A] });
    await service.send({ recipientId: 'm1', title: 't', body: 'b' });
    expect(deliver.mock.calls[0][1].data).toEqual({});
  });

  it('registers and forgets devices for the person', async () => {
    const { service, repo } = setup();
    await service.registerDevice('u1', TOKEN_A, 'ios');
    expect(repo.saveDevice).toHaveBeenCalledWith('u1', TOKEN_A, 'ios');
    await expect(service.removeDevices('u1', TOKEN_A)).resolves.toBe(1);
    expect(repo.removeDevices).toHaveBeenCalledWith('u1', TOKEN_A);
    await service.removeDevices('u1');
    expect(repo.removeDevices).toHaveBeenLastCalledWith('u1', undefined);
  });

  describe('when someone is signed out', () => {
    const fire = (changes: UserAccessChangedEvent['changes'], active?: boolean) => {
      const { service, repo, handlers } = setup();
      service.onModuleInit();
      return Promise.resolve(
        handlers.get(UserAccessChangedEvent.eventName)!(
          new UserAccessChangedEvent('u1', changes, new Date(), active),
        ),
      ).then(() => repo.removeDevices);
    };

    it.each([
      [['DELETED'], undefined],
      [['SIGN_OUT'], undefined],
      [['STATUS'], false],
    ] as const)('%s forgets their phones', async (changes, active) => {
      expect(await fire([...changes], active)).toHaveBeenCalledWith('u1');
    });

    it.each([
      [['STATUS'], true],
      [['ROLE'], undefined],
      [['MANAGER'], undefined],
      [['PASSWORD'], undefined],
    ] as const)('%s keeps them', async (changes, active) => {
      expect(await fire([...changes], active)).not.toHaveBeenCalled();
    });
  });

  describe('a phone signed out but still holding a working access token', () => {
    const HOUR = 3_600_000;
    const TTL = 15 * 60_000;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    async function fire(event: unknown, name: string, accessTtl = '15m') {
      const { service, repo, handlers } = setup({ accessTtl });
      service.onModuleInit();
      await handlers.get(name)!(event);
      return repo;
    }

    it('an administrator signing them out: whatever it registers again is forgotten', async () => {
      const repo = await fire(
        new UserAccessChangedEvent('u1', ['SIGN_OUT'], new Date()),
        UserAccessChangedEvent.eventName,
      );
      expect(repo.removeDevices).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(TTL - 1000);
      expect(repo.removeDevices).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(repo.removeDevices).toHaveBeenCalledTimes(2);
      expect(repo.removeDevices).toHaveBeenLastCalledWith('u1');
    });

    it('it waits as long as the access token lives, however long that is', async () => {
      const repo = await fire(
        new UserAccessChangedEvent('u1', ['SIGN_OUT'], new Date()),
        UserAccessChangedEvent.eventName,
        '1h',
      );
      await jest.advanceTimersByTimeAsync(HOUR - 1000);
      expect(repo.removeDevices).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(repo.removeDevices).toHaveBeenCalledTimes(2);
    });

    it('their own password change with sign-out forgets their phones the same way', async () => {
      const repo = await fire(
        new OtherDevicesSignedOutEvent('u1'),
        OtherDevicesSignedOutEvent.eventName,
      );
      expect(repo.removeDevices).toHaveBeenCalledWith('u1');
      await jest.advanceTimersByTimeAsync(TTL + 60_000);
      expect(repo.removeDevices).toHaveBeenCalledTimes(2);
    });

    it('someone blocked or deleted is refused at once: one removal is enough', async () => {
      for (const event of [
        new UserAccessChangedEvent('u1', ['DELETED'], new Date(), false),
        new UserAccessChangedEvent('u1', ['STATUS'], new Date(), false),
      ]) {
        const repo = await fire(event, UserAccessChangedEvent.eventName);
        await jest.advanceTimersByTimeAsync(TTL + 60_000);
        expect(repo.removeDevices).toHaveBeenCalledTimes(1);
      }
    });

    it('a failed second removal is only logged', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const { service, repo, handlers } = setup();
      service.onModuleInit();
      await handlers.get(UserAccessChangedEvent.eventName)!(
        new UserAccessChangedEvent('u1', ['SIGN_OUT'], new Date()),
      );
      repo.removeDevices.mockRejectedValueOnce(new Error('db down'));
      await jest.advanceTimersByTimeAsync(TTL + 60_000);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  it('warns at boot when the flag is on and no credentials are set', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    setup({ configured: false }).service.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    setup({ configured: true }).service.onModuleInit();
    setup({ flag: false, configured: false }).service.onModuleInit();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
