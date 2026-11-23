import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PUSH_PROVIDER } from './domain/push-provider';
import { PUSH_REPOSITORY } from './domain/push.repository';
import { PrismaPushRepository } from './infrastructure/prisma-push.repository';
import { FcmHttpProvider, FcmSettings } from './infrastructure/fcm-http.provider';
import { PushService } from './application/push.service';
import { DevicesController } from './presentation/devices.controller';

/**
 * Push notifications, the server half (3.6): device tokens, the outbox and sending
 * through a provider. Import this module and inject PushService to send one.
 * It knows nothing about what the pushes are for.
 *
 * 4.0: a token belongs to a person, never to an organisation; a push goes only to the
 * person it names (whoever decides an item is worked out by the approval sync).
 */
@Module({
  controllers: [DevicesController],
  providers: [
    { provide: PUSH_REPOSITORY, useClass: PrismaPushRepository },
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new FcmHttpProvider(config.get<FcmSettings>('push.fcm') ?? {}),
    },
    PushService,
  ],
  exports: [PushService],
})
export class PushModule {}
