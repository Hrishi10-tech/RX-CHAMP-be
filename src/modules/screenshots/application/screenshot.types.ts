import { ScreenshotKind } from '../domain/screenshot.repository';

export interface ScreenshotView {
  id: string;
  userId: string | null;
  kind: string;
  takenAt: string;
  /** Short-lived presigned URL the browser can load directly. */
  url: string;
}

export interface ListScreenshotsResult {
  userId: string;
  total: number;
  items: ScreenshotView[];
}

export interface UploadScreenshotInput {
  buffer: Buffer;
  contentType?: string;
  kind?: ScreenshotKind;
  takenAt?: Date;
}
