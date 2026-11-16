import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Wraps the S3 bucket for screenshot storage. Credentials live only here on the
 * server (from env) — they are never shipped to the agent. The server never
 * writes an image itself: the agent uploads through a presigned POST
 * (presignUpload). Objects are stored private; callers get short-lived presigned
 * GET URLs to display them.
 */
@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: ConfigService) {
    const region = config.get<string>('s3.region')!;
    const accessKeyId = config.get<string>('s3.accessKeyId')!;
    const secretAccessKey = config.get<string>('s3.secretAccessKey')!;
    this.bucket = config.get<string>('s3.bucket')!;
    this.prefix = config.get<string>('s3.prefix') ?? '';
    this.client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  }

  /**
   * Full object key for a user's screenshot, under the configured prefix. 3.3: the
   * real extension (.jpg once re-encoded); readers use the stored key, so older
   * .png objects keep working.
   */
  buildKey(userId: string, takenAt: Date, id: string, extension: 'png' | 'jpg' = 'png'): string {
    const day = takenAt.toISOString().slice(0, 10); // YYYY-MM-DD
    const stamp = takenAt.toISOString().replace(/[:.]/g, '-');
    return `${this.prefix}screenshots/${userId}/${day}/${stamp}-${id}.${extension}`;
  }

  /**
   * True when `key` is one this service would build for `userId`: under their own
   * folder, plain characters only. The agent hands the key back after a direct
   * upload, so it must never be able to claim someone else's object.
   */
  isKeyOf(userId: string, key: string): boolean {
    const own = `${this.prefix}screenshots/${userId}/`;
    return (
      key.startsWith(own) && /^\d{4}-\d{2}-\d{2}\/[\w-]+\.(png|jpg)$/.test(key.slice(own.length))
    );
  }

  /**
   * A presigned POST the agent uploads one object to directly. S3 itself enforces
   * the key, the content type and the size range, so the link cannot be used to
   * store anything else, anywhere else, or anything larger.
   */
  presignUpload(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresInSeconds: number,
  ): Promise<{ url: string; fields: Record<string, string> }> {
    return createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Fields: { 'Content-Type': contentType },
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Expires: expiresInSeconds,
    });
  }

  /** Size of a stored object, or null when there is no such object. */
  async sizeOf(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') return null;
      throw err;
    }
  }

  /** The object's bytes, or only the first `bytes` of them. */
  async read(key: string, bytes?: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: bytes ? `bytes=0-${bytes - 1}` : undefined,
      }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  /** Best effort: a refused upload should not stay in the bucket. */
  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.logger.warn(`could not delete s3://${this.bucket}/${key}: ${(err as Error).message}`);
    }
  }

  /** A time-limited URL the browser can load directly. */
  presignGet(key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
