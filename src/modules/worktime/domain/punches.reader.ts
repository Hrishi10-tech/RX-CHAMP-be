export const PUNCHES_READER = Symbol('PUNCHES_READER');

/** A biometric punch as the day views show it (3.5). The biometric module writes them. */
export interface DayPunch {
  id: string;
  at: Date;
  direction: 'IN' | 'OUT' | null;
  deviceId: string;
  /** PUSH, PULL, CSV or MANUAL. */
  source: string;
  note: string | null;
  voided: boolean;
}

export interface PunchesReader {
  /** Punches matched to these people on these working days, oldest first, by `userId|date`. */
  punchesOf(userIds: string[], fromDate: string, toDate: string): Promise<Map<string, DayPunch[]>>;
}
