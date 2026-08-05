import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DetectDocumentTextCommand, TextractClient } from '@aws-sdk/client-textract';


@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly client: TextractClient;

  constructor(config: ConfigService) {
    this.client = new TextractClient({
      region: config.get<string>('s3.region')!,
      credentials: {
        accessKeyId: config.get<string>('s3.accessKeyId')!,
        secretAccessKey: config.get<string>('s3.secretAccessKey')!,
      },
    });
  }

  async extractText(image: Buffer): Promise<string | null> {
    try {
      const res = await this.client.send(new DetectDocumentTextCommand({ Document: { Bytes: image } }));
      const lines = (res.Blocks ?? [])
        .filter((b) => b.BlockType === 'LINE' && b.Text)
        .map((b) => b.Text as string);
      const text = lines.join('\n').trim();
      return text.length ? text : null;
    } catch (e) {
      this.logger.warn(`OCR failed: ${(e as Error).message}`);
      return null;
    }
  }
}
