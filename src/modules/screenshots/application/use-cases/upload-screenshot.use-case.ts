import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AgentContactService } from '@modules/agent-health/application/agent-contact.service';
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
import {
  MAX_OCR_BYTES,
  normaliseScreenshot,
  sniffImageType,
} from '../../infrastructure/image-normaliser';
import { ScreenshotMapper } from '../screenshot.mapper';
import { ScreenshotView, UploadScreenshotInput } from '../screenshot.types';

export { sniffImageType };

/** Local calendar day (YYYY-MM-DD), server timezone — matches activity + presence. */
function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** A capture stamped this far ahead of the server clock is taken as "now". */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;

/**
 * Largest upload accepted (3.3; was 8 MB). A two-monitor 4K PNG is 20 MB and was
 * refused with 413 on every attempt, which is how screenshots came to work for
 * some people and not others. The image is re-encoded on arrival, so the limit
 * only bounds what travels, not what is stored. nginx must allow at least this
 * much (`client_max_body_size`, see DEPLOYMENT.md).
 */
export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

/** Textract is given this long; a slow OCR must never hold up the agent. */
export const OCR_TIMEOUT_MS = 20_000;

/**
 * The agent uploads a captured screenshot: normalise it, store it in S3, record
 * it, answer. OCR runs afterwards, in the background. Every refusal is recorded
 * against the person (GET /agent-health shows the last one and why).
 */
@Injectable()
export class UploadScreenshotUseCase {
  private readonly logger = new Logger(UploadScreenshotUseCase.name);

  constructor(
    @Inject(SCREENSHOT_REPOSITORY) private readonly repo: ScreenshotRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    @Inject(SCREENSHOT_POLICY_READER) private readonly policy: ScreenshotPolicyReader,
    private readonly s3: S3StorageService,
    private readonly ocr: OcrService,
    private readonly contacts: AgentContactService,
  ) {}

  async execute(userId: string, input: UploadScreenshotInput): Promise<ScreenshotView> {
    try {
      return await this.accept(userId, input);
    } catch (err) {
      this.recordRefusal(userId, err, input.buffer?.length ?? 0);
      throw err;
    }
  }

  private async accept(userId: string, input: UploadScreenshotInput): Promise<ScreenshotView> {
    const size = input.buffer?.length ?? 0;
    if (!size) throw new BadRequestException('Empty screenshot');
    if (size > MAX_SCREENSHOT_BYTES) {
      // Rounded up, so a file one byte over never reads as "32 MB; the limit is 32 MB".
      const shown = Math.ceil((size / 1048576) * 100) / 100;
      throw new PayloadTooLargeException(
        `Screenshot is ${shown} MB (${size.toLocaleString('en-US')} bytes); the limit is ${MAX_SCREENSHOT_BYTES / 1048576} MB.`,
      );
    }
    // Only real PNG/JPEG images are stored; the declared type is not trusted.
    if (!sniffImageType(input.buffer)) {
      throw new BadRequestException('Screenshots must be PNG or JPEG images');
    }

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

    // One predictable size whatever the screen produced (a bounded JPEG).
    const image = (await normaliseScreenshot(input.buffer))!;
    if (image.reencoded) {
      this.logger.debug(
        `screenshot of ${userId}: ${mb(size)} MB -> ${mb(image.bytes.length)} MB (${image.width}x${image.height})`,
      );
    }
    const key = this.s3.buildKey(userId, takenAt, randomUUID(), image.extension);
    await this.s3.upload(key, image.bytes, image.contentType);
    const rec = await this.repo.create({ userId, storageKey: key, kind, takenAt, ocrText: null });

    // OCR after the answer: the agent never waits on Textract, and a slow or
    // failing OCR costs the search index one shot, never the shot itself.
    this.ocrLater(rec.id, image.bytes);

    const url = await this.s3.presignGet(key);
    return ScreenshotMapper.toView(rec, url);
  }

  /** Best effort, bounded by OCR_TIMEOUT_MS; the result lands when it lands. */
  private ocrLater(id: string, image: Buffer): void {
    if (image.length > MAX_OCR_BYTES) return;
    const run = async () => {
      const text = await this.ocr.extractText(image, OCR_TIMEOUT_MS);
      if (text) await this.repo.setOcrText(id, text);
    };
    setImmediate(() => {
      run().catch((err: Error) => this.logger.warn(`OCR of ${id} skipped: ${err.message}`));
    });
  }

  private recordRefusal(userId: string, err: unknown, bytes: number): void {
    if (!(err instanceof HttpException)) return;
    const status = err.getStatus();
    const code =
      status === 413
        ? 'TOO_LARGE'
        : status === 403
          ? 'AUTO_OFF'
          : status === 409
            ? 'DAY_ENDED'
            : bytes === 0
              ? 'EMPTY'
              : 'NOT_AN_IMAGE';
    this.contacts.refused(userId, { status, code, reason: err.message, bytes });
    this.logger.warn(`screenshot of ${userId} refused (${code}, ${bytes} bytes): ${err.message}`);
  }
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
