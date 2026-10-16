import { Readable } from 'stream';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AgentBinaryInfo, AgentBinaryStore } from '../domain/agent-binary.store';

/**
 * Serves the agent binary from S3 — the production path, where the installer
 * folder was never copied into the container image. Expects a single object (the
 * signed .exe), so it is never a "directory": the per-user enrollment is appended
 * as the exe trailer by the controller, exactly as for a local single-file build.
 *
 * Reuses the same bucket/credentials as screenshot storage unless `AGENT_S3_BUCKET`
 * overrides the bucket.
 */
export class S3AgentBinaryStore implements AgentBinaryStore {
  private readonly logger = new Logger(S3AgentBinaryStore.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    config: ConfigService,
    private readonly key: string,
  ) {
    const accessKeyId = config.get<string>('s3.accessKeyId');
    const secretAccessKey = config.get<string>('s3.secretAccessKey');
    this.client = new S3Client({
      region: config.get<string>('s3.region')!,
      // Empty keys fall back to the default provider chain (instance role etc.).
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
    this.bucket = config.get<string>('agent.s3Bucket') || config.get<string>('s3.bucket')!;
  }

  async info(): Promise<AgentBinaryInfo> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      // Stamped by scripts/publish-agent.ps1. The SDK lowercases metadata keys.
      const meta = head.Metadata ?? {};
      return {
        available: true,
        sizeBytes: head.ContentLength ?? 0,
        isDirectory: false,
        version: meta['agent-version'] || undefined,
        sha256: meta['agent-sha256'] || undefined,
      };
    } catch (err) {
      // A missing object (404) just means "not uploaded yet" — not an error.
      this.logger.debug(
        `agent binary not in s3://${this.bucket}/${this.key}: ${(err as Error).message}`,
      );
      return { available: false, sizeBytes: 0, isDirectory: false };
    }
  }

  async openStream(): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
    );
    // In the Node SDK the streamed body is a Readable.
    return res.Body as Readable;
  }

  directoryPath(): null {
    return null; // an S3 object is never a directory
  }
}
