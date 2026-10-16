import { ForbiddenException } from '@nestjs/common';
import { UploadScreenshotUseCase } from './upload-screenshot.use-case';

/**
 * The per-user screenshot switch gates AUTO captures only. A manager asking for a
 * shot by hand is a deliberate act and must always get through — the two controls
 * are unrelated, and conflating them was the main risk in this feature.
 */
describe('UploadScreenshotUseCase — screenshot switch', () => {
  const repo = { create: jest.fn() } as any;
  const dayEnds = { hasEnded: jest.fn() } as any;
  const policy = { isAutoEnabled: jest.fn() } as any;
  const s3 = { buildKey: jest.fn(), upload: jest.fn(), presignGet: jest.fn() } as any;
  const ocr = { extractText: jest.fn() } as any;

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
    useCase = new UploadScreenshotUseCase(repo, dayEnds, policy, s3, ocr);
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
