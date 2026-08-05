export const SCREENSHOT_REPOSITORY = Symbol('SCREENSHOT_REPOSITORY');

export type ScreenshotKind = 'AUTO' | 'MANUAL';

export interface ScreenshotRecord {
  id: string;
  userId: string | null;
  storageKey: string;
  kind: ScreenshotKind;
  takenAt: Date;
  createdAt: Date;
}

export interface CreateScreenshotData {
  userId: string;
  storageKey: string;
  kind: ScreenshotKind;
  takenAt: Date;
  ocrText?: string | null;
}

export interface ListScreenshotsFilter {
  limit: number;
  offset?: number;
  from?: Date;
  to?: Date;
  kind?: ScreenshotKind;
  q?: string;
  includeArchived?: boolean;
}

export interface ScreenshotRepository {
  create(data: CreateScreenshotData): Promise<ScreenshotRecord>;
  listForUser(userId: string, filter: ListScreenshotsFilter): Promise<ScreenshotRecord[]>;
  countForUser(userId: string, filter: ListScreenshotsFilter): Promise<number>;
  archive(userId: string, ids: string[]): Promise<number>;
}
