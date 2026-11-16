import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  MAX_DIRECT_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  UploadScreenshotUseCase,
} from './upload-screenshot.use-case';

/**
 * Presigned uploads: the agent asks for a link, uploads straight to S3, then
 * says it is done. The gates hold at both ends, a
 * key can only be one of the caller's own, and anything refused after the
 * upload is deleted from the bucket.
 */
describe('UploadScreenshotUseCase — presigned uploads', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const KEY = 'uploads/screenshots/u-1/2026-11-12/2026-11-12T05-00-00-000Z-abc.jpg';

  const repo = { create: jest.fn(), setOcrText: jest.fn(), findByStorageKey: jest.fn() } as any;
  const dayEnds = { hasEnded: jest.fn() } as any;
  const policy = { isAutoEnabled: jest.fn() } as any;
  const s3 = {
    buildKey: jest.fn(),
    presignUpload: jest.fn(),
    presignGet: jest.fn(),
    isKeyOf: jest.fn(),
    sizeOf: jest.fn(),
    read: jest.fn(),
    remove: jest.fn(),
  } as any;
  const ocr = { extractText: jest.fn() } as any;
  const contacts = { refused: jest.fn() } as any;
  let useCase: UploadScreenshotUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    policy.isAutoEnabled.mockResolvedValue(true);
    dayEnds.hasEnded.mockResolvedValue(false);
    s3.buildKey.mockReturnValue(KEY);
    s3.presignUpload.mockResolvedValue({ url: 'https://bucket.s3', fields: { key: KEY } });
    s3.presignGet.mockResolvedValue('https://signed');
    s3.isKeyOf.mockImplementation((u: string, k: string) => k.includes(`/screenshots/${u}/`));
    s3.sizeOf.mockResolvedValue(400_000);
    s3.read.mockResolvedValue(JPEG);
    s3.remove.mockResolvedValue(undefined);
    ocr.extractText.mockResolvedValue(null);
    repo.findByStorageKey.mockResolvedValue(null);
    repo.create.mockImplementation((d: any) =>
      Promise.resolve({ id: 's-1', createdAt: new Date(), ...d }),
    );
    useCase = new UploadScreenshotUseCase(repo, dayEnds, policy, s3, ocr, contacts);
  });

  describe('requestUpload', () => {
    it('returns a presigned POST held to the key, type, size limit and lifetime', async () => {
      const ticket = await useCase.requestUpload('u-1', {
        contentType: 'image/jpeg',
        kind: 'AUTO',
      });

      expect(ticket).toEqual({
        key: KEY,
        url: 'https://bucket.s3',
        fields: { key: KEY },
        maxBytes: MAX_DIRECT_UPLOAD_BYTES,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
      expect(s3.buildKey).toHaveBeenCalledWith('u-1', expect.any(Date), expect.any(String), 'jpg');
      expect(s3.presignUpload).toHaveBeenCalledWith(
        KEY,
        'image/jpeg',
        MAX_DIRECT_UPLOAD_BYTES,
        UPLOAD_URL_TTL_SECONDS,
      );
    });

    it('refuses before any link exists when automatic screenshots are off', async () => {
      policy.isAutoEnabled.mockResolvedValue(false);

      await expect(
        useCase.requestUpload('u-1', { contentType: 'image/jpeg' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(s3.presignUpload).not.toHaveBeenCalled();
      expect(contacts.refused).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ code: 'AUTO_OFF' }),
      );
    });

    it('still gives a manual capture a link when automatic screenshots are off', async () => {
      policy.isAutoEnabled.mockResolvedValue(false);

      await useCase.requestUpload('u-1', { contentType: 'image/jpeg', kind: 'MANUAL' });

      expect(s3.presignUpload).toHaveBeenCalled();
    });

    it('refuses after End Day', async () => {
      dayEnds.hasEnded.mockResolvedValue(true);

      await expect(
        useCase.requestUpload('u-1', { contentType: 'image/jpeg' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(s3.presignUpload).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    it('checks the stored object and records it', async () => {
      const view = await useCase.completeUpload('u-1', { key: KEY, kind: 'AUTO' });

      expect(s3.read).toHaveBeenCalledWith(KEY, 16);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-1', storageKey: KEY, kind: 'AUTO' }),
      );
      expect(view).toMatchObject({ id: 's-1', url: 'https://signed' });
      expect(s3.remove).not.toHaveBeenCalled();
    });

    it("refuses someone else's key without touching S3", async () => {
      const theirs = KEY.replace('/u-1/', '/u-2/');

      await expect(useCase.completeUpload('u-1', { key: theirs })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(s3.sizeOf).not.toHaveBeenCalled();
      expect(s3.remove).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(contacts.refused).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ code: 'BAD_KEY' }),
      );
    });

    it('refuses when nothing was uploaded', async () => {
      s3.sizeOf.mockResolvedValue(null);

      await expect(useCase.completeUpload('u-1', { key: KEY })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.create).not.toHaveBeenCalled();
      expect(contacts.refused).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ code: 'NOT_UPLOADED' }),
      );
    });

    it('deletes and refuses an object over the limit', async () => {
      s3.sizeOf.mockResolvedValue(MAX_DIRECT_UPLOAD_BYTES + 1);

      await expect(useCase.completeUpload('u-1', { key: KEY })).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(s3.remove).toHaveBeenCalledWith(KEY);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('deletes and refuses an object that is not a PNG or JPEG', async () => {
      s3.read.mockResolvedValue(Buffer.from('<html>nope</html>'));

      await expect(useCase.completeUpload('u-1', { key: KEY })).rejects.toThrow(/PNG or JPEG/);
      expect(s3.remove).toHaveBeenCalledWith(KEY);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('deletes a shot that was in flight when the day ended', async () => {
      dayEnds.hasEnded.mockResolvedValue(true);

      await expect(useCase.completeUpload('u-1', { key: KEY })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(s3.remove).toHaveBeenCalledWith(KEY);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('returns the first record when the same key is completed twice', async () => {
      repo.findByStorageKey.mockResolvedValue({
        id: 's-0',
        userId: 'u-1',
        storageKey: KEY,
        kind: 'AUTO',
        takenAt: new Date(),
        createdAt: new Date(),
      });

      const view = await useCase.completeUpload('u-1', { key: KEY });

      expect(view).toMatchObject({ id: 's-0' });
      expect(repo.create).not.toHaveBeenCalled();
      expect(s3.sizeOf).not.toHaveBeenCalled();
    });

    it('treats a missing kind as AUTO, so it is gated', async () => {
      policy.isAutoEnabled.mockResolvedValue(false);

      await expect(useCase.completeUpload('u-1', { key: KEY })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(s3.remove).toHaveBeenCalledWith(KEY);
    });

    it('never dates a capture in the future', async () => {
      const ahead = new Date(Date.now() + 60 * 60_000);

      await useCase.completeUpload('u-1', { key: KEY, takenAt: ahead });

      const { takenAt } = repo.create.mock.calls[0][0];
      expect(takenAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('runs OCR after answering and survives an OCR failure', async () => {
      ocr.extractText.mockResolvedValueOnce('invoice 42');
      await useCase.completeUpload('u-1', { key: KEY });
      await new Promise((r) => setTimeout(r, 20));
      expect(repo.setOcrText).toHaveBeenCalledWith('s-1', 'invoice 42');

      ocr.extractText.mockRejectedValueOnce(new Error('textract down'));
      await expect(useCase.completeUpload('u-1', { key: KEY })).resolves.toMatchObject({
        id: 's-1',
      });
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});
