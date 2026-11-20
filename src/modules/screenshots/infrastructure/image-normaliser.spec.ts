import sharp from 'sharp';
import { crc32, deflateSync } from 'zlib';
import { MAX_INPUT_PIXELS, isDecodableImage, sniffImageType } from './image-normaliser';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
}

/**
 * A complete, valid PNG of black pixels (8 bit greyscale). It compresses to a
 * few hundred KB whatever its size, which is how a huge image fits an upload.
 */
function blackPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  // One filter byte and `width` zero bytes per row.
  const rows = deflateSync(Buffer.alloc(height * (width + 1)), { level: 1 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', rows),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 3.6 (F-15): a direct upload is kept only when it really decodes. */
describe('isDecodableImage', () => {
  it('accepts a real PNG and a real JPEG', async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    await expect(isDecodableImage(png)).resolves.toBe(true);
    await expect(isDecodableImage(jpeg)).resolves.toBe(true);
  });

  it('refuses bytes that only carry an image header', async () => {
    const fakePng = Buffer.concat([PNG_SIGNATURE, Buffer.from('not really an image at all')]);
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
    expect(sniffImageType(fakePng)).toBe('image/png');
    await expect(isDecodableImage(fakePng)).resolves.toBe(false);
    await expect(isDecodableImage(fakeJpeg)).resolves.toBe(false);
  });

  it('refuses anything that is not a PNG or JPEG', async () => {
    await expect(isDecodableImage(Buffer.from('GIF89a........'))).resolves.toBe(false);
    await expect(isDecodableImage(Buffer.alloc(0))).resolves.toBe(false);
  });

  it('refuses a valid image over the pixel limit', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;
    await expect(isDecodableImage(blackPng(side, side))).resolves.toBe(false);
  });

  it('keeps a real capture cut off part way', async () => {
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#808080' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const cut = png.subarray(0, Math.floor(png.length * 0.8));
    await expect(isDecodableImage(cut)).resolves.toBe(true);
  });
});
