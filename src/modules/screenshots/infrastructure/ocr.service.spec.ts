import { ConfigService } from '@nestjs/config';
import { TextractClient } from '@aws-sdk/client-textract';
import { OcrService } from './ocr.service';

jest.mock('@aws-sdk/client-textract', () => ({
  TextractClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Blocks: [{ BlockType: 'LINE', Text: 'hello' }] }),
  })),
  DetectDocumentTextCommand: jest.fn(),
}));

function serviceWith(enabled: boolean | undefined): {
  ocr: OcrService;
  send: () => jest.Mock;
} {
  const values: Record<string, unknown> = {
    'ocr.enabled': enabled,
    's3.region': 'ap-south-1',
    's3.accessKeyId': 'k',
    's3.secretAccessKey': 's',
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const ocr = new OcrService(config);
  const mock = TextractClient as unknown as jest.Mock;
  const client = mock.mock.results[mock.mock.results.length - 1].value as { send: jest.Mock };
  return { ocr, send: () => client.send };
}

describe('OcrService', () => {
  it('reads the text when OCR is on (the default)', async () => {
    const { ocr, send } = serviceWith(undefined);
    await expect(ocr.extractText(Buffer.from('x'))).resolves.toBe('hello');
    expect(send()).toHaveBeenCalledTimes(1);
  });

  it('never calls AWS when OCR is switched off', async () => {
    const { ocr, send } = serviceWith(false);
    await expect(ocr.extractText(Buffer.from('x'))).resolves.toBeNull();
    expect(send()).not.toHaveBeenCalled();
  });
});
