import sharp from 'sharp';

/**
 * Screenshot checks. The agent uploads straight to S3 (a JPEG at most 2560 px
 * wide), so the server no longer re-encodes anything; it only checks that what
 * landed is a real image and is small enough to OCR.
 */

/** Textract reads at most 10 MB in one synchronous call; stay well under. */
export const MAX_OCR_BYTES = 5 * 1024 * 1024;

/** The image type from its first bytes; the client's declared type is not trusted. */
export function sniffImageType(buffer: Buffer): 'image/png' | 'image/jpeg' | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/**
 * 3.6 (F-15): the most pixels any reader of screenshots will decode. A screen
 * capture is far below it (four 4K monitors are 33 million).
 */
export const MAX_INPUT_PIXELS = 80_000_000;

/**
 * 3.6 (F-15): whether the bytes are a PNG or JPEG that really decodes, within
 * MAX_INPUT_PIXELS. Magic bytes alone let anything with an image header through;
 * what was not decoded is never kept. A real capture cut off part way still
 * decodes (failOn 'none') and is kept.
 */
export async function isDecodableImage(bytes: Buffer): Promise<boolean> {
  if (!sniffImageType(bytes)) return false;
  try {
    // A small resize forces a full decode of every pixel row.
    await sharp(bytes, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: 32, withoutEnlargement: true })
      .raw()
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}
