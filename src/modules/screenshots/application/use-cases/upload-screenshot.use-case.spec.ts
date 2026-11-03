import { ForbiddenException, PayloadTooLargeException } from '@nestjs/common';
import { MAX_SCREENSHOT_BYTES, UploadScreenshotUseCase } from './upload-screenshot.use-case';

/**
 * The per-user screenshot switch gates AUTO captures only. A manager asking for a
 * shot by hand is a deliberate act and must always get through — the two controls
 * are unrelated, and conflating them was the main risk in this feature.
 */
describe('UploadScreenshotUseCase — screenshot switch', () => {
  const repo = { create: jest.fn(), setOcrText: jest.fn() } as any;
  const dayEnds = { hasEnded: jest.fn() } as any;
  const policy = { isAutoEnabled: jest.fn() } as any;
  const s3 = { buildKey: jest.fn(), upload: jest.fn(), presignGet: jest.fn() } as any;
  const ocr = { extractText: jest.fn() } as any;
  const contacts = { refused: jest.fn() } as any;

  // A real PNG signature: uploads are sniffed and anything else is refused.
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('rest'),
  ]);
  let useCase: UploadScreenshotUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    dayEnds.hasEnded.mockResolvedValue(false);
    s3.buildKey.mockReturnValue('uploads/k.png');
    s3.upload.mockResolvedValue(undefined);
    s3.presignGet.mockResolvedValue('https://signed');
    ocr.extractText.mockResolvedValue(null);
    repo.create.mockImplementation((d: any) =>
      Promise.resolve({ id: 's-1', takenAt: d.takenAt, kind: d.kind, ocrText: null, ...d }),
    );
    useCase = new UploadScreenshotUseCase(repo, dayEnds, policy, s3, ocr, contacts);
  });

  it('refuses an automatic capture when the switch is off', async () => {
    policy.isAutoEnabled.mockResolvedValue(false);

    await expect(useCase.execute('u-1', { buffer, kind: 'AUTO' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Nothing stored and nothing uploaded to S3.
    expect(repo.create).not.toHaveBeenCalled();
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('still accepts a manual capture when the switch is off', async () => {
    policy.isAutoEnabled.mockResolvedValue(false);

    const view = await useCase.execute('u-1', { buffer, kind: 'MANUAL' });

    expect(view).toBeDefined();
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MANUAL' }));
  });

  it('accepts an automatic capture when the switch is on', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);

    await useCase.execute('u-1', { buffer, kind: 'AUTO' });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'AUTO' }));
  });

  it('treats a missing kind as AUTO, so it is gated', async () => {
    policy.isAutoEnabled.mockResolvedValue(false);

    await expect(useCase.execute('u-1', { buffer })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a file that is not a PNG or JPEG, whatever type it claims', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);

    await expect(
      useCase.execute('u-1', {
        buffer: Buffer.from('<html>not an image</html>'),
        kind: 'MANUAL',
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/PNG or JPEG/);
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('stores a JPEG with its real content type', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await useCase.execute('u-1', { buffer: jpeg, kind: 'MANUAL', contentType: 'image/png' });

    expect(s3.upload).toHaveBeenCalledWith(expect.any(String), jpeg, 'image/jpeg');
  });

  it('never dates a capture in the future', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);
    const future = new Date(Date.now() + 60 * 60_000);

    await useCase.execute('u-1', { buffer, kind: 'MANUAL', takenAt: future });

    const stored = repo.create.mock.calls[0][0].takenAt as Date;
    expect(stored.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not even ask about the switch for a manual capture', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);

    await useCase.execute('u-1', { buffer, kind: 'MANUAL' });

    expect(policy.isAutoEnabled).not.toHaveBeenCalled();
  });
});

describe('UploadScreenshotUseCase — size, re-encoding, OCR and refusals (3.3)', () => {
  const repo = { create: jest.fn(), setOcrText: jest.fn() } as any;
  const dayEnds = { hasEnded: jest.fn() } as any;
  const policy = { isAutoEnabled: jest.fn() } as any;
  const s3 = { buildKey: jest.fn(), upload: jest.fn(), presignGet: jest.fn() } as any;
  const ocr = { extractText: jest.fn() } as any;
  const contacts = { refused: jest.fn() } as any;
  let useCase: UploadScreenshotUseCase;

  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    jest.clearAllMocks();
    dayEnds.hasEnded.mockResolvedValue(false);
    policy.isAutoEnabled.mockResolvedValue(true);
    s3.buildKey.mockImplementation(
      (_u: string, _t: Date, id: string, ext: string) => `k/${id}.${ext}`,
    );
    s3.upload.mockResolvedValue(undefined);
    s3.presignGet.mockResolvedValue('https://signed');
    ocr.extractText.mockResolvedValue('Invoice 42');
    repo.create.mockImplementation((d: any) => Promise.resolve({ id: 's-1', ...d }));
    repo.setOcrText.mockResolvedValue(undefined);
    useCase = new UploadScreenshotUseCase(repo, dayEnds, policy, s3, ocr, contacts);
  });

  // The background OCR of one test must not land in the next one.
  afterEach(async () => {
    await flush();
    await flush();
  });

  it('re-encodes a real screenshot as a bounded JPEG and answers before OCR', async () => {
    // A 3000 px wide PNG, like a 4K capture: wider than the bound, so it shrinks.
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 3000, height: 1200, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

    await useCase.execute('u-1', { buffer: png, kind: 'AUTO' });
    // OCR has not held the answer up; it lands afterwards.
    expect(repo.setOcrText).not.toHaveBeenCalled();

    const [key, bytes, type] = s3.upload.mock.calls[0];
    expect(key).toMatch(/\.jpg$/);
    expect(type).toBe('image/jpeg');
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2560);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: key, ocrText: null }),
    );
    await flush();
    await flush();
    expect(ocr.extractText).toHaveBeenCalledWith(bytes, expect.any(Number));
    expect(repo.setOcrText).toHaveBeenCalledWith('s-1', 'Invoice 42');
    expect(contacts.refused).not.toHaveBeenCalled();
  });

  it('keeps an undecodable but real image as it came', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await useCase.execute('u-1', { buffer: jpeg, kind: 'MANUAL' });
    expect(s3.upload).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/), jpeg, 'image/jpeg');
  });

  it('refuses an upload over the limit with 413 and records it', async () => {
    const huge = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 0x89);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(useCase.execute('u-1', { buffer: huge })).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(contacts.refused).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ status: 413, code: 'TOO_LARGE', bytes: huge.length }),
    );
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('records every other refusal with its cause', async () => {
    policy.isAutoEnabled.mockResolvedValue(false);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest'),
    ]);
    await expect(useCase.execute('u-1', { buffer: png })).rejects.toThrow();
    expect(contacts.refused).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ code: 'AUTO_OFF', status: 403 }),
    );

    policy.isAutoEnabled.mockResolvedValue(true);
    dayEnds.hasEnded.mockResolvedValue(true);
    await expect(useCase.execute('u-1', { buffer: png })).rejects.toThrow();
    expect(contacts.refused).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ code: 'DAY_ENDED', status: 409 }),
    );

    dayEnds.hasEnded.mockResolvedValue(false);
    await expect(useCase.execute('u-1', { buffer: Buffer.from('nope') })).rejects.toThrow();
    expect(contacts.refused).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ code: 'NOT_AN_IMAGE', status: 400 }),
    );

    await expect(useCase.execute('u-1', { buffer: Buffer.alloc(0) })).rejects.toThrow();
    expect(contacts.refused).toHaveBeenLastCalledWith(
      'u-1',
      expect.objectContaining({ code: 'EMPTY', bytes: 0 }),
    );
  });

  it('skips OCR when it finds nothing, and survives an OCR failure', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    ocr.extractText.mockResolvedValueOnce(null);
    await useCase.execute('u-1', { buffer: jpeg, kind: 'MANUAL' });
    await flush();
    await flush();
    expect(repo.setOcrText).not.toHaveBeenCalled();

    ocr.extractText.mockRejectedValueOnce(new Error('textract down'));
    await expect(useCase.execute('u-1', { buffer: jpeg, kind: 'MANUAL' })).resolves.toBeDefined();
    await flush();
    await flush();
    expect(repo.setOcrText).not.toHaveBeenCalled();
  });
});
