import sharp from 'sharp';

/**
 * Screenshot normalisation (3.3). Agents send whatever the screen produced: a
 * 4K or two-monitor PNG runs to 10 to 25 MB, which the old 8 MB limit refused
 * outright (so "screenshots work for some people and not others" depended on
 * the monitor). Every accepted image is re-encoded here as a JPEG no wider than
 * MAX_WIDTH, so storage, the portal, the PDF reports and OCR all get one
 * predictable size (a few hundred KB) whatever arrived.
 */

/** Wide enough to read two 1280-wide monitors side by side. */
export const MAX_WIDTH = 2560;
export const JPEG_QUALITY = 80;
/** Textract reads at most 10 MB in one synchronous call; stay well under. */
export const MAX_OCR_BYTES = 5 * 1024 * 1024;

export interface NormalisedImage {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
  width: number | null;
  height: number | null;
  /** False when the original bytes were kept (re-encoding failed). */
  reencoded: boolean;
}

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
 * Re-encodes a PNG or JPEG screenshot as a bounded JPEG. When sharp cannot decode
 * it (a truncated capture), the original is kept as it is, so a readable image
 * is never thrown away for being odd. Returns null only for bytes that are not
 * an image at all.
 */
export async function normaliseScreenshot(original: Buffer): Promise<NormalisedImage | null> {
  const sniffed = sniffImageType(original);
  if (!sniffed) return null;
  try {
    const { data, info } = await sharp(original, { failOn: 'none', limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      contentType: 'image/jpeg',
      extension: 'jpg',
      width: info.width,
      height: info.height,
      reencoded: true,
    };
  } catch {
    return {
      bytes: original,
      contentType: sniffed,
      extension: sniffed === 'image/png' ? 'png' : 'jpg',
      width: null,
      height: null,
      reencoded: false,
    };
  }
}
