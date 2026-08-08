import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  SCREENSHOT_REPOSITORY,
  ScreenshotKind,
  ScreenshotRepository,
} from '../../domain/screenshot.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { S3StorageService } from '../../infrastructure/s3-storage.service';
import { OcrService } from '../../infrastructure/ocr.service';
import { ScreenshotMapper } from '../screenshot.mapper';
import { ScreenshotView, UploadScreenshotInput } from '../screenshot.types';

/** Local calendar day (YYYY-MM-DD), server timezone — matches activity + presence. */
function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The agent uploads a captured screenshot: store the image in S3, record it in the DB. */
@Injectable()
export class UploadScreenshotUseCase {
  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    private readonly s3: S3StorageService,
    private readonly ocr: OcrService,
  ) {}

  async execute(userId: string, input: UploadScreenshotInput): Promise<ScreenshotView> {
    if (!input.buffer?.length) throw new BadRequestException('Empty screenshot');

    const takenAt = input.takenAt ?? new Date();
    const kind: ScreenshotKind = input.kind ?? 'AUTO';

    // Capture stops dead at "End Day". A shot that arrives after it — one already
    // in flight, or an agent restarted after signing off — is refused rather than
    // stored, so nothing lands in the day after the user was told it was over.
    if (await this.dayEnds.hasEnded(userId, localDateString(takenAt))) {
      throw new ConflictException('Your working day has ended; captures have stopped.');
    }

    const key = this.s3.buildKey(userId, takenAt, randomUUID());

    // Store the image, and OCR it (best-effort) so it becomes text-searchable.
    const [, ocrText] = await Promise.all([
      this.s3.upload(key, input.buffer, input.contentType ?? 'image/png'),
      this.ocr.extractText(input.buffer),
    ]);
    const rec = await this.repo.create({ userId, storageKey: key, kind, takenAt, ocrText });

    const url = await this.s3.presignGet(key);
    return ScreenshotMapper.toView(rec, url);
  }
}
