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

  const buffer = Buffer.from('fake-png-bytes');
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

  it('does not even ask about the switch for a manual capture', async () => {
    policy.isAutoEnabled.mockResolvedValue(true);

    await useCase.execute('u-1', { buffer, kind: 'MANUAL' });

    expect(policy.isAutoEnabled).not.toHaveBeenCalled();
  });
});
