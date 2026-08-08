import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Wraps the S3 bucket for screenshot storage. Credentials live only here on the
 * server (from env) — they are never shipped to the agent. Objects are stored
 * private; callers get short-lived presigned GET URLs to display them.
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

  /** Full object key for a user's screenshot, under the configured prefix. */
  buildKey(userId: string, takenAt: Date, id: string): string {
    const day = takenAt.toISOString().slice(0, 10); // YYYY-MM-DD
    const stamp = takenAt.toISOString().replace(/[:.]/g, '-');
    return `${this.prefix}screenshots/${userId}/${day}/${stamp}-${id}.png`;
  }

  async upload(key: string, body: Buffer, contentType = 'image/png'): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    this.logger.debug(`uploaded s3://${this.bucket}/${key} (${body.length} bytes)`);
  }

  /** A time-limited URL the browser can load directly. */
  presignGet(key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
