import { Global, Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.port';
import { InMemoryEventBus } from './in-memory-event-bus';

@Global()
@Module({
  providers: [InMemoryEventBus, { provide: EVENT_BUS, useExisting: InMemoryEventBus }],
  exports: [EVENT_BUS],
})
export class EventsModule {}
