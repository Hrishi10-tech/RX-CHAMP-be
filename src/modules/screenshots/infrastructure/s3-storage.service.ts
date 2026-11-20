import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

/** A streaming upload in progress: wait for it, or abort it. */
export interface StreamUpload {
  done(): Promise<void>;
  abort(): Promise<void>;
}

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
    const endpoint = config.get<string>('s3.endpoint') || undefined;
    this.bucket = config.get<string>('s3.bucket')!;
    this.prefix = config.get<string>('s3.prefix') ?? '';
    this.client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint
        ? { endpoint, forcePathStyle: config.get<boolean>('s3.forcePathStyle') ?? true }
        : {}),
    });
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

  /** Object key of a screenshot report or monthly archive (3.2). */
  exportKey(exportId: string, fileName: string): string {
    return `${this.prefix}exports/${exportId}/${fileName}`;
  }

  async upload(key: string, body: Buffer, contentType = 'image/png'): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
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

  /** The whole object as bytes. */
  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  /**
   * Streams `body` into one object (multipart, so files of many gigabytes are fine).
   * Start it, feed the stream, then await done(); abort() drops the parts.
   */
  uploadStream(key: string, body: Readable, contentType: string): StreamUpload {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const finished = upload.done().then(() => undefined);
    // An abort makes done() reject; whoever aborts handles that.
    finished.catch(() => undefined);
    return {
      done: () => finished,
      abort: async () => {
        try {
          await upload.abort();
        } catch {
          // Nothing uploaded yet, or already finished.
        }
      },
    };
  }

  /** Deletes up to any number of objects, 1000 per request. Returns how many went. */
  async deleteMany(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
    let deleted = 0;
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const errors = new Set((res.Errors ?? []).map((e) => e.Key ?? ''));
      for (const k of batch) {
        if (errors.has(k)) failed.push(k);
        else deleted += 1;
      }
    }
    return { deleted, failed };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** A time-limited URL the browser can load directly (a download name makes it a file). */
  presignGet(key: string, expiresInSeconds = 3600, downloadName?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(downloadName
          ? {
              ResponseContentDisposition: `attachment; filename="${downloadName.replace(/["\\]/g, '')}"`,
            }
          : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}
