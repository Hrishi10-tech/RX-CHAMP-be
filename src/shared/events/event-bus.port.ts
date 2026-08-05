export const EVENT_BUS = Symbol('EVENT_BUS');

export interface DomainEventEnvelope<T = unknown> {
  name: string;
  payload: T;
}

export interface EventBus {
  publish<T>(name: string, payload: T): Promise<void>;
  subscribe<T>(name: string, handler: (payload: T) => void | Promise<void>): void;
}
