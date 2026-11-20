import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { PassThrough, Readable } from 'node:stream';

/**
 * PDFs of screenshots (3.2, fixes 6 and 7): a cover page with the person, the
 * period and the days, then every screenshot on its own landscape A4 page with
 * its date and time printed above it and stamped on the image itself.
 *
 * Images are scaled down and re-encoded as JPEG first (a full-size PNG is up to
 * 8 MB; a month would not fit any inbox or disk), so a page is about 100 to 200 KB.
 */

export interface ImageQuality {
  maxWidth: number;
  jpegQuality: number;
}

/** The report one person downloads: sharper. */
export const REPORT_QUALITY: ImageQuality = { maxWidth: 1600, jpegQuality: 72 };
/** The monthly archive of everyone: smaller, still readable. */
export const ARCHIVE_QUALITY: ImageQuality = { maxWidth: 1366, jpegQuality: 62 };

export interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Scales and re-encodes one screenshot; null when the bytes are not an image. */
export async function prepareImage(bytes: Buffer, q: ImageQuality): Promise<PreparedImage | null> {
  try {
    const { data, info } = await sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: q.maxWidth, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: q.jpegQuality, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** Text the built-in PDF fonts can draw (Latin-1); anything else is simplified. */
export function pdfText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function zoneLabel(tz: string, at: Date): string {
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

/** "Tue 14 Oct 2026" and "17:05:12 IST" in the business timezone. */
export function stampParts(at: Date, tz: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
    .format(at)
    .replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return { date, time: `${time} ${zoneLabel(tz, at)}` };
}

export interface PdfPerson {
  name: string;
  email: string;
  department: string | null;
}

export interface PdfDaySummary {
  date: string;
  label: string;
  count: number;
  first: Date | null;
  last: Date | null;
}

export interface PdfShot {
  takenAt: Date;
  kind: 'AUTO' | 'MANUAL';
  image: PreparedImage | null;
}

const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = 28;
const INK = '#16181d';
const MUTED = '#5b6270';
const LINE = '#d7dbe2';

/**
 * One screenshot PDF, written as a stream: cover(), then shot() for each
 * screenshot in time order, then end().
 */
export class ScreenshotPdf {
  private readonly doc: PDFKit.PDFDocument;
  private readonly out = new PassThrough();
  private pages = 0;
  private bytes = 0;
  private readonly chunks: Buffer[] | null;

  /**
   * `collect`: keep the bytes in memory for toBuffer() (a day of the archive);
   * otherwise read them from `stream` as they come (a report streamed to storage).
   */
  constructor(
    private readonly opts: {
      title: string;
      person: PdfPerson;
      periodLabel: string;
      tz: string;
      generatedAt: Date;
      generatedBy: string;
    },
    collect = false,
  ) {
    this.chunks = collect ? [] : null;
    this.doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      autoFirstPage: false,
      compress: true,
      info: {
        Title: pdfText(`${opts.title}: ${opts.person.name}, ${opts.periodLabel}`),
        Author: 'RX Vision',
        Creator: 'RX Vision',
        Subject: 'Screenshots',
      },
    });
    this.doc.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
    });
    this.doc.pipe(this.out);
    if (this.chunks) this.out.on('data', (c: Buffer) => this.chunks!.push(c));
  }

  /** The PDF bytes as they are written. */
  get stream(): Readable {
    return this.out;
  }

  get size(): number {
    return this.bytes;
  }

  /** The first page: who, when, how many, and the days. */
  cover(days: PdfDaySummary[], total: number, missing: number): void {
    const d = this.doc;
    d.addPage();
    this.pages += 1;
    const tz = this.opts.tz;
    d.fillColor(INK).font('Helvetica-Bold').fontSize(24).text(pdfText(this.opts.title), MARGIN, 48);
    d.moveDown(0.3);
    d.font('Helvetica').fontSize(14).fillColor(MUTED).text(pdfText(this.opts.periodLabel));
    d.moveDown(1.2);

    const rows: [string, string][] = [
      ['Employee', this.opts.person.name],
      ['Email', this.opts.person.email],
      ['Department', this.opts.person.department ?? 'No department'],
      ['Screenshots', String(total)],
      ['Days with screenshots', String(days.filter((x) => x.count > 0).length)],
      [
        'Made',
        `${stampParts(this.opts.generatedAt, tz).date}, ${stampParts(this.opts.generatedAt, tz).time} by ${this.opts.generatedBy}`,
      ],
    ];
    if (missing > 0) rows.push(['Images that could not be read', String(missing)]);
    for (const [k, v] of rows) {
      const y = d.y;
      d.font('Helvetica').fontSize(11).fillColor(MUTED).text(pdfText(k), MARGIN, y, { width: 170 });
      d.font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(INK)
        .text(pdfText(v), MARGIN + 180, y, {
          width: PAGE.width - MARGIN * 2 - 180,
        });
      d.moveDown(0.35);
    }

    if (days.length) {
      d.moveDown(0.8);
      d.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Days', MARGIN);
      d.moveDown(0.3);
      const colX = [MARGIN, MARGIN + 200, MARGIN + 320, MARGIN + 440];
      const head = ['Day', 'Screenshots', 'First', 'Last'];
      let y = d.y;
      d.font('Helvetica').fontSize(9).fillColor(MUTED);
      head.forEach((h, i) => d.text(h, colX[i], y, { width: 110 }));
      y += 14;
      d.moveTo(MARGIN, y - 3)
        .lineTo(MARGIN + 560, y - 3)
        .strokeColor(LINE)
        .lineWidth(0.5)
        .stroke();
      d.fillColor(INK).fontSize(10);
      for (const day of days) {
        if (y > PAGE.height - MARGIN - 20) {
          d.addPage();
          this.pages += 1;
          y = MARGIN + 10;
        }
        const cells = [
          day.label,
          String(day.count),
          day.first ? stampParts(day.first, tz).time : '-',
          day.last ? stampParts(day.last, tz).time : '-',
        ];
        cells.forEach((c, i) => d.text(pdfText(c), colX[i], y, { width: 190 }));
        y += 15;
      }
    }
    if (total === 0) {
      d.moveDown(1.5);
      d.font('Helvetica')
        .fontSize(12)
        .fillColor(MUTED)
        .text('No screenshots were taken in this period.', MARGIN);
    }
    this.footer();
  }

  /** One screenshot on its own page, stamped with its date and time. */
  shot(s: PdfShot, index: number, total: number): void {
    const d = this.doc;
    d.addPage();
    this.pages += 1;
    const tz = this.opts.tz;
    const stamp = stampParts(s.takenAt, tz);
    const headY = MARGIN - 6;
    d.font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text(pdfText(this.opts.person.name), MARGIN, headY, {
        width: 360,
        lineBreak: false,
      });
    const right = `${stamp.date}  ${stamp.time}`;
    d.font('Helvetica-Bold')
      .fontSize(12)
      .text(pdfText(right), PAGE.width - MARGIN - 360, headY, {
        width: 360,
        align: 'right',
        lineBreak: false,
      });
    d.font('Helvetica').fontSize(9).fillColor(MUTED);
    d.text(
      pdfText(
        `${this.opts.person.department ?? 'No department'}  |  ${s.kind === 'MANUAL' ? 'Requested by a manager' : 'Automatic'}  |  ${index} of ${total}`,
      ),
      MARGIN,
      headY + 17,
      { width: PAGE.width - MARGIN * 2, lineBreak: false },
    );

    const boxX = MARGIN;
    const boxY = headY + 34;
    const boxW = PAGE.width - MARGIN * 2;
    const boxH = PAGE.height - boxY - MARGIN - 14;
    if (s.image) {
      const scale = Math.min(boxW / s.image.width, boxH / s.image.height);
      const w = s.image.width * scale;
      const h = s.image.height * scale;
      const x = boxX + (boxW - w) / 2;
      const y = boxY;
      d.image(s.image.jpeg, x, y, { width: w, height: h });
      d.rect(x, y, w, h).strokeColor(LINE).lineWidth(0.5).stroke();
      // The stamp on the image itself, so a cropped page still says when it was.
      const label = pdfText(`${stamp.date}  ${stamp.time}`);
      d.font('Helvetica-Bold').fontSize(10);
      const tw = d.widthOfString(label) + 14;
      d.save();
      d.rect(x + 8, y + h - 26, tw, 18)
        .fillOpacity(0.72)
        .fill('#000000');
      d.restore();
      d.fillColor('#ffffff')
        .fillOpacity(1)
        .text(label, x + 15, y + h - 22, { lineBreak: false });
    } else {
      d.rect(boxX, boxY, boxW, boxH).strokeColor(LINE).lineWidth(0.5).stroke();
      d.font('Helvetica')
        .fontSize(12)
        .fillColor(MUTED)
        .text('This screenshot could not be read.', boxX, boxY + boxH / 2 - 8, {
          width: boxW,
          align: 'center',
        });
    }
    this.footer();
  }

  private footer(): void {
    const d = this.doc;
    // The footer sits in the bottom margin: lift the margin while writing it, or the
    // text engine would think the page is full and start another.
    const bottom = d.page.margins.bottom;
    d.page.margins.bottom = 0;
    d.font('Helvetica').fontSize(8).fillColor(MUTED);
    d.text(
      pdfText(
        `RX Vision  |  ${this.opts.title}  |  ${this.opts.person.name}  |  Page ${this.pages}`,
      ),
      MARGIN,
      PAGE.height - MARGIN + 6,
      { width: PAGE.width - MARGIN * 2, align: 'center', lineBreak: false },
    );
    d.page.margins.bottom = bottom;
  }

  /** Finishes the file; resolves once every byte is out. */
  end(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.out.once('end', () => resolve());
      this.out.once('error', reject);
      this.doc.end();
    });
  }

  /** Finishes a collected file and returns it whole (a day of the archive). */
  async toBuffer(): Promise<Buffer> {
    if (!this.chunks) throw new Error('This PDF streams; read `stream` instead.');
    await this.end();
    return Buffer.concat(this.chunks);
  }
}
