import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DetectDocumentTextCommand, TextractClient } from '@aws-sdk/client-textract';

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly client: TextractClient;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('ocr.enabled') ?? true;
    this.client = new TextractClient({
      region: config.get<string>('s3.region')!,
      credentials: {
        accessKeyId: config.get<string>('s3.accessKeyId')!,
        secretAccessKey: config.get<string>('s3.secretAccessKey')!,
      },
    });
  }

  /**
   * The text in an image, or null (no text, switched off with OCR_ENABLED=false, not
   * configured, failed, or past `timeoutMs`). Never throws: OCR only feeds the search box.
   */
  async extractText(image: Buffer, timeoutMs = 20_000): Promise<string | null> {
    if (!this.enabled) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await this.client.send(
        new DetectDocumentTextCommand({ Document: { Bytes: image } }),
        { abortSignal: abort.signal },
      );
      const lines = (res.Blocks ?? [])
        .filter((b) => b.BlockType === 'LINE' && b.Text)
        .map((b) => b.Text as string);
      const text = lines.join('\n').trim();
      return text.length ? text : null;
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(
        abort.signal.aborted ? `OCR gave up after ${timeoutMs} ms` : `OCR failed: ${msg}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
