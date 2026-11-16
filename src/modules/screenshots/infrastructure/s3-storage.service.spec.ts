import { S3StorageService } from './s3-storage.service';

/** The agent hands a key back after a direct upload; only its own may pass. */
describe('S3StorageService.isKeyOf', () => {
  const config = {
    get: (k: string) =>
      ({
        's3.region': 'ap-south-1',
        's3.accessKeyId': 'x',
        's3.secretAccessKey': 'y',
        's3.bucket': 'b',
        's3.prefix': 'uploads/',
      })[k],
  } as any;
  const s3 = new S3StorageService(config);
  const at = new Date('2026-11-12T05:00:00.000Z');

  it('accepts a key it builds for that user', () => {
    expect(s3.isKeyOf('u-1', s3.buildKey('u-1', at, 'abc-123', 'jpg'))).toBe(true);
    expect(s3.isKeyOf('u-1', s3.buildKey('u-1', at, 'abc-123', 'png'))).toBe(true);
  });

  it("refuses another user's key, a path escape or another prefix", () => {
    expect(s3.isKeyOf('u-1', s3.buildKey('u-2', at, 'abc', 'jpg'))).toBe(false);
    expect(s3.isKeyOf('u-1', 'uploads/screenshots/u-1/../u-2/2026-11-12/x.jpg')).toBe(false);
    expect(s3.isKeyOf('u-1', 'uploads/screenshots/u-1/2026-11-12/x.exe')).toBe(false);
    expect(s3.isKeyOf('u-1', 'other/screenshots/u-1/2026-11-12/x.jpg')).toBe(false);
    // A user id that is a prefix of another must not match the longer one.
    expect(s3.isKeyOf('u-1', 'uploads/screenshots/u-10/2026-11-12/x.jpg')).toBe(false);
  });
});
