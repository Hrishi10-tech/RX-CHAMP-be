import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  SCREENSHOT_REPOSITORY,
  ScreenshotKind,
  ScreenshotRepository,
} from '../../domain/screenshot.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import {
  SCREENSHOT_POLICY_READER,
  ScreenshotPolicyReader,
} from '../../domain/screenshot-policy.reader';
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

/** The image type from its first bytes; the client's declared type is not trusted. */
export function sniffImageType(buffer: Buffer): 'image/png' | 'image/jpeg' | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  return null;
}

/** A capture stamped this far ahead of the server clock is taken as "now". */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;

/** The agent uploads a captured screenshot: store the image in S3, record it in the DB. */
@Injectable()
export class UploadScreenshotUseCase {
  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    @Inject(SCREENSHOT_POLICY_READER) private readonly policy: ScreenshotPolicyReader,
    private readonly s3: S3StorageService,
    private readonly ocr: OcrService,
  ) {}

  async execute(userId: string, input: UploadScreenshotInput): Promise<ScreenshotView> {
    if (!input.buffer?.length) throw new BadRequestException('Empty screenshot');
    // Only real PNG/JPEG images are stored, served with the type they really are.
    const contentType = sniffImageType(input.buffer);
    if (!contentType) throw new BadRequestException('Screenshots must be PNG or JPEG images');

    const now = new Date();
    const claimed = input.takenAt && !Number.isNaN(input.takenAt.getTime()) ? input.takenAt : now;
    const takenAt = claimed.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS ? now : claimed;
    const kind: ScreenshotKind = input.kind ?? 'AUTO';

    // Automatic capture can be switched off per user. The agent is told and stops
    // on its own, but a shot already in flight when the switch flipped would
    // otherwise still land — so refuse it here too. A MANUAL capture is a manager
    // asking for one deliberately and is never gated by this.
    if (kind === 'AUTO' && !(await this.policy.isAutoEnabled(userId))) {
      throw new ForbiddenException('Automatic screenshots are switched off for this user.');
    }

    // Capture stops dead at "End Day". A shot that arrives after it — one already
    // in flight, or an agent restarted after signing off — is refused rather than
    // stored, so nothing lands in the day after the user was told it was over.
    if (await this.dayEnds.hasEnded(userId, localDateString(takenAt))) {
      throw new ConflictException('Your working day has ended; captures have stopped.');
    }

    const key = this.s3.buildKey(userId, takenAt, randomUUID());

    // Store the image, and OCR it (best-effort) so it becomes text-searchable.
    const [, ocrText] = await Promise.all([
      this.s3.upload(key, input.buffer, contentType),
      this.ocr.extractText(input.buffer),
    ]);
    const rec = await this.repo.create({ userId, storageKey: key, kind, takenAt, ocrText });

    const url = await this.s3.presignGet(key);
    return ScreenshotMapper.toView(rec, url);
  }
}
