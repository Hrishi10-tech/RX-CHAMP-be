import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
  isDecodableImage,
  sniffImageType,
} from '../../infrastructure/image-normaliser';
import { ScreenshotMapper } from '../screenshot.mapper';
import { ScreenshotView } from '../screenshot.types';

export { sniffImageType };

/** Local calendar day (YYYY-MM-DD), server timezone — matches activity + presence. */
function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** A capture stamped this far ahead of the server clock is taken as "now". */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;

/** Textract is given this long; a slow OCR must never hold up the agent. */
export const OCR_TIMEOUT_MS = 20_000;

/**
 * Largest direct (presigned) upload. Nothing re-encodes a direct upload, so the
 * agent sends a JPEG of at most 2560 px wide (about 0.3 to 1 MB); this is room to
 * spare, enforced by S3 itself through the presigned POST policy.
 */
export const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How long a presigned upload link stays valid. */
export const UPLOAD_URL_TTL_SECONDS = 300;

export interface RequestUploadInput {
  contentType: 'image/jpeg' | 'image/png';
  kind?: ScreenshotKind;
  takenAt?: Date;
}

export interface CompleteUploadInput {
  key: string;
  kind?: ScreenshotKind;
  takenAt?: Date;
}

/** Where and how the agent uploads one shot: POST `fields` + the file to `url`. */
export interface UploadTicket {
  key: string;
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
  expiresIn: number;
}

/** The capture time the agent claims, or now when it is missing, invalid or ahead. */
function takenAtOf(claimed: Date | undefined): Date {
  const now = new Date();
  const at = claimed && !Number.isNaN(claimed.getTime()) ? claimed : now;
  return at.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS ? now : at;
}

/**
 * Screenshots reach S3 only through a presigned POST: the agent asks for a link
 * (requestUpload), uploads the image straight to S3, then reports it done
 * (completeUpload). The server never carries the image bytes on the way in. OCR
 * runs afterwards, in the background. Every refusal is recorded against the
 * person (GET /agent-health shows the last one and why).
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

  /**
   * Step 1: the agent asks where to put a shot. The gates run first, so a refused
   * shot is never uploaded at all.
   * The answer is a presigned POST that S3 holds to this key, this content type
   * and at most MAX_DIRECT_UPLOAD_BYTES, for UPLOAD_URL_TTL_SECONDS.
   */
  async requestUpload(userId: string, input: RequestUploadInput): Promise<UploadTicket> {
    try {
      const takenAt = takenAtOf(input.takenAt);
      const kind: ScreenshotKind = input.kind ?? 'AUTO';
      await this.gate(userId, kind, takenAt);
      const extension = input.contentType === 'image/png' ? 'png' : 'jpg';
      const key = this.s3.buildKey(userId, takenAt, randomUUID(), extension);
      const post = await this.s3.presignUpload(
        key,
        input.contentType,
        MAX_DIRECT_UPLOAD_BYTES,
        UPLOAD_URL_TTL_SECONDS,
      );
      return {
        key,
        url: post.url,
        fields: post.fields,
        maxBytes: MAX_DIRECT_UPLOAD_BYTES,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      };
    } catch (err) {
      this.recordRefusal(userId, err, 0);
      throw err;
    }
  }

  /**
   * Direct upload, step 2: the agent says the object is in S3. It is checked
   * (theirs, there, within the limit, a real PNG or JPEG) and recorded. The gates
   * run again for a shot that was in flight when the switch flipped or the day
   * ended; anything refused here is deleted from the bucket. Completing the same
   * key twice returns the first record.
   */
  async completeUpload(userId: string, input: CompleteUploadInput): Promise<ScreenshotView> {
    const { key } = input;
    let size = 0;
    let refusal: string | undefined;
    try {
      if (!this.s3.isKeyOf(userId, key)) {
        refusal = 'BAD_KEY';
        throw new BadRequestException('That upload key is not yours.');
      }
      const existing = await this.repo.findByStorageKey(key);
      if (existing) return ScreenshotMapper.toView(existing, await this.s3.presignGet(key));

      const found = await this.s3.sizeOf(key);
      if (found === null) {
        refusal = 'NOT_UPLOADED';
        throw new NotFoundException('Nothing was uploaded under that key.');
      }
      size = found;
      if (size > MAX_DIRECT_UPLOAD_BYTES) {
        await this.s3.remove(key);
        throw new PayloadTooLargeException(
          `Screenshot is ${mb(size)} MB; the limit is ${MAX_DIRECT_UPLOAD_BYTES / 1048576} MB.`,
        );
      }
      // 3.6 (F-15): only an image that really decodes is kept. A PNG or JPEG
      // header on anything else is refused and the object deleted.
      const bytes = await this.s3.read(key);
      if (!(await isDecodableImage(bytes))) {
        await this.s3.remove(key);
        throw new BadRequestException('Screenshots must be PNG or JPEG images');
      }

      const takenAt = takenAtOf(input.takenAt);
      const kind: ScreenshotKind = input.kind ?? 'AUTO';
      try {
        await this.gate(userId, kind, takenAt);
      } catch (err) {
        await this.s3.remove(key);
        throw err;
      }

      const rec = await this.repo.create({ userId, storageKey: key, kind, takenAt, ocrText: null });
      // OCR after the answer, from the bytes already read (ocrLater skips large ones).
      this.ocrLater(rec.id, bytes);
      return ScreenshotMapper.toView(rec, await this.s3.presignGet(key));
    } catch (err) {
      this.recordRefusal(userId, err, size, refusal);
      throw err;
    }
  }

  /**
   * Automatic capture can be switched off per user. The agent is told and stops
   * on its own, but a shot already in flight when the switch flipped would
   * otherwise still land, so it is refused here too. A MANUAL capture is a
   * manager asking for one deliberately and is never gated by this.
   *
   * Capture also stops dead at "End Day". A shot that arrives after it (one in
   * flight, or an agent restarted after signing off) is refused rather than
   * stored, so nothing lands in the day after the user was told it was over.
   */
  private async gate(userId: string, kind: ScreenshotKind, takenAt: Date): Promise<void> {
    if (kind === 'AUTO' && !(await this.policy.isAutoEnabled(userId))) {
      throw new ForbiddenException('Automatic screenshots are switched off for this user.');
    }
    if (await this.dayEnds.hasEnded(userId, localDateString(takenAt))) {
      throw new ConflictException('Your working day has ended; captures have stopped.');
    }
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

  private recordRefusal(userId: string, err: unknown, bytes: number, forced?: string): void {
    if (!(err instanceof HttpException)) return;
    const status = err.getStatus();
    const code =
      forced ??
      (status === 413
        ? 'TOO_LARGE'
        : status === 403
          ? 'AUTO_OFF'
          : status === 409
            ? 'DAY_ENDED'
            : bytes === 0
              ? 'EMPTY'
              : 'NOT_AN_IMAGE');
    this.contacts.refused(userId, { status, code, reason: err.message, bytes });
    this.logger.warn(`screenshot of ${userId} refused (${code}, ${bytes} bytes): ${err.message}`);
  }
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
