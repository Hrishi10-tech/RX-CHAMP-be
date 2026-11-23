import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { FeatureFlagsService } from '@shared/features/feature-flags.service';
import { parseDurationMs } from '@shared/utils/duration';
import { PUSH_PROVIDER, PushDelivery, PushProvider } from '../domain/push-provider';
import { PUSH_REPOSITORY, PushRepository } from '../domain/push.repository';
import { PushMessage, PushPlatform, PushSentState } from '../domain/push.types';

/** Past the last access token's expiry, so a request sent just before it has landed. */
const AFTER_EXPIRY_MS = 10_000;

/**
 * Push notifications, the server half (3.6). Any module imports PushModule and
 * calls send(): the outbox row is always written, and the message goes out only
 * while the `mobilePush` flag is on and the provider has its credentials. Send never
 * throws, so a push can never break what asked for it.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(PUSH_REPOSITORY) private readonly repo: PushRepository,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly features: FeatureFlagsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.features.isOn('mobilePush') && !this.provider.configured) {
      this.logger.warn(
        'mobilePush is on but FCM credentials are not set: pushes are only recorded',
      );
    }
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.onAccessChanged(e),
    );
    this.events.subscribe<OtherDevicesSignedOutEvent>(OtherDevicesSignedOutEvent.eventName, (e) =>
      this.forgetSignedOut(e.userId),
    );
  }

  /** The state the outbox row ended in. */
  async send(message: PushMessage): Promise<PushSentState> {
    let rowId: string;
    try {
      rowId = (await this.repo.record(message)).id;
    } catch (err) {
      this.logger.warn(`push outbox write failed (${(err as Error).name})`);
      return 'FAILED';
    }
    if (!this.features.isOn('mobilePush') || !this.provider.configured) return 'NOT_SENT';
    try {
      return await this.deliver(rowId, message);
    } catch (err) {
      this.logger.warn(`push ${rowId} failed (${(err as Error).name})`);
      await this.settle(rowId, 'FAILED', 0, 0, 'ERROR').catch(() => undefined);
      return 'FAILED';
    }
  }

  /** The signed-in person's phone. Registering again moves a token to them. */
  registerDevice(userId: string, token: string, platform: PushPlatform): Promise<void> {
    return this.repo.saveDevice(userId, token, platform);
  }

  /** Forgets one of the person's phones, or all of them when no token is named. */
  removeDevices(userId: string, token?: string): Promise<number> {
    return this.repo.removeDevices(userId, token);
  }

  private async deliver(rowId: string, message: PushMessage): Promise<PushSentState> {
    const devices = await this.repo.devicesOf(message.recipientId);
    if (!devices.length) {
      await this.settle(rowId, 'NO_DEVICE', 0, 0, null);
      return 'NO_DEVICE';
    }
    const payload = { title: message.title, body: message.body, data: message.data ?? {} };
    const answers = await Promise.all(
      devices.map(async (d) => {
        const answer: PushDelivery = await this.provider.deliver(d.token, payload);
        if (!answer.ok && answer.code === 'UNREGISTERED') await this.repo.removeToken(d.token);
        return answer;
      }),
    );
    const delivered = answers.filter((a) => a.ok).length;
    const refused = answers.find((a): a is Exclude<PushDelivery, { ok: true }> => !a.ok);
    const state: PushSentState = delivered > 0 ? 'SENT' : 'FAILED';
    await this.settle(rowId, state, devices.length, delivered, refused?.code ?? null);
    return state;
  }

  private settle(
    id: string,
    sentState: PushSentState,
    devices: number,
    delivered: number,
    errorCode: string | null,
  ): Promise<void> {
    return this.repo.settle(id, {
      sentState,
      devices,
      delivered,
      errorCode,
      sentAt: sentState === 'SENT' ? new Date() : null,
    });
  }

  /** Someone whose sessions just ended should not get pushes on those phones. */
  private async onAccessChanged(e: UserAccessChangedEvent): Promise<void> {
    if (e.changes.includes('SIGN_OUT')) return this.forgetSignedOut(e.userId);
    const gone = e.changes.some((c) => c === 'DELETED' || (c === 'STATUS' && e.active === false));
    if (gone) await this.repo.removeDevices(e.userId);
  }

  /**
   * Signed out, but not blocked: a phone's access token works until it expires, and the
   * phone registers on every start and resume. So its token is forgotten again once
   * no such access token is left. Someone who signed back in meanwhile registers again
   * on their next start or resume. A restart inside the window loses the second removal.
   */
  private async forgetSignedOut(userId: string): Promise<void> {
    await this.repo.removeDevices(userId);
    const ttl = parseDurationMs(this.config.get<string>('jwt.accessTtl') ?? '15m');
    setTimeout(() => {
      this.repo
        .removeDevices(userId)
        .catch((err: Error) => this.logger.warn(`push devices not removed (${err.name})`));
    }, ttl + AFTER_EXPIRY_MS).unref();
  }
}
