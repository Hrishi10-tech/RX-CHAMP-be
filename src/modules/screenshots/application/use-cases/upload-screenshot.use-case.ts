import { randomUUID } from 'crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  SCREENSHOT_REPOSITORY,
  ScreenshotKind,
  ScreenshotRepository,
} from '../../domain/screenshot.repository';
import { S3StorageService } from '../../infrastructure/s3-storage.service';
import { OcrService } from '../../infrastructure/ocr.service';
import { ScreenshotMapper } from '../screenshot.mapper';
import { ScreenshotView, UploadScreenshotInput } from '../screenshot.types';

/** The agent uploads a captured screenshot: store the image in S3, record it in the DB. */
@Injectable()
export class UploadScreenshotUseCase {
  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    private readonly s3: S3StorageService,
    private readonly ocr: OcrService,
  ) {}

  async execute(userId: string, input: UploadScreenshotInput): Promise<ScreenshotView> {
    if (!input.buffer?.length) throw new BadRequestException('Empty screenshot');

    const takenAt = input.takenAt ?? new Date();
    const kind: ScreenshotKind = input.kind ?? 'AUTO';
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
