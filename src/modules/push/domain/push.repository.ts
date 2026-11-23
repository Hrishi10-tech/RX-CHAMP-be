import { PushMessage, PushPlatform, PushSentState } from './push.types';

export const PUSH_REPOSITORY = Symbol('PUSH_REPOSITORY');

export interface PushDeviceRow {
  token: string;
  platform: string;
}

export interface PushSettlement {
  sentState: PushSentState;
  devices: number;
  delivered: number;
  errorCode: string | null;
  sentAt: Date | null;
}

export interface PushRepository {
  /** A token belongs to one person: registering it again moves it to them. */
  saveDevice(userId: string, token: string, platform: PushPlatform): Promise<void>;
  /** The person's devices (a token they do not hold is left alone); how many went. */
  removeDevices(userId: string, token?: string): Promise<number>;
  /** A token the provider says is dead, whoever held it. */
  removeToken(token: string): Promise<void>;
  devicesOf(userId: string): Promise<PushDeviceRow[]>;
  /** The outbox row, written before anything is attempted. */
  record(message: PushMessage): Promise<{ id: string }>;
  settle(id: string, result: PushSettlement): Promise<void>;
}
