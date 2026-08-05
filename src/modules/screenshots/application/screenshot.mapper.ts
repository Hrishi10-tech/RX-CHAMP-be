import { ScreenshotRecord } from '../domain/screenshot.repository';
import { ScreenshotView } from './screenshot.types';

export class ScreenshotMapper {
  static toView(rec: ScreenshotRecord, url: string): ScreenshotView {
    return {
      id: rec.id,
      userId: rec.userId,
      kind: rec.kind,
      takenAt: rec.takenAt.toISOString(),
      url,
    };
  }
}
