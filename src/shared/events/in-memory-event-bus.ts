import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { EventBus } from './event-bus.port';

@Injectable()
export class InMemoryEventBus implements EventBus {
  private readonly logger = new Logger(InMemoryEventBus.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  async publish<T>(name: string, payload: T): Promise<void> {
    this.logger.debug(`event published: ${name}`);
    this.emitter.emit(name, payload);
  }

  subscribe<T>(name: string, handler: (payload: T) => void | Promise<void>): void {
    this.emitter.on(name, (payload: T) => {
      Promise.resolve(handler(payload)).catch((e) =>
        this.logger.error(`handler for ${name} failed: ${(e as Error).message}`),
      );
    });
  }
}
