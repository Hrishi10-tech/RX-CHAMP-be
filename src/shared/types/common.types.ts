export interface TimeInterval {
  start: Date;
  end: Date;
}

/** An app / website / category and the seconds spent on it. */
export interface UsageEntry {
  name: string;
  seconds: number;
}

export interface HourBucket {
  hour: number; // 0–23
  activeSec: number;
  idleSec: number;
}

/** A single day's value in a trend series. */
export interface DayValue {
  date: string; // YYYY-MM-DD
  value: number;
}

export type BulkError<K extends string> = Record<K, string> & { error: string };
