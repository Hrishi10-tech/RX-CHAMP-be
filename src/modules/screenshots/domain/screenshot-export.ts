import {
  addDaysToKey,
  isValidDateKey,
  isValidHm,
  hmToMinutes,
  zonedMinutesToUtc,
} from '@shared/utils/timezone';

/**
 * Screenshot reports and monthly archives (3.2, fixes 6 and 7), as pure rules.
 *
 *   Report   one person, one PDF: a day, several days, a whole month, or a time of
 *            day window on one date (17:00 to 19:00). Every screenshot on its own
 *            page with its date and time stamped on it.
 *   Archive  every screenshot of a month, as a zip of
 *            <Month>/<Department>/<Employee>/<YYYY-MM-DD Day>.pdf (one PDF per day
 *            that has screenshots). Can be made any time.
 *   Delete   a month's screenshots go only once the month has ended and a complete
 *            archive of it, started after the month ended, has been downloaded.
 *            Only screenshots that archive holds are deleted: anything uploaded
 *            after it started (an offline backlog) stays until the next archive.
 */

export type ExportKind = 'PERSON_REPORT' | 'MONTH_ARCHIVE' | 'MONTH_PURGE';
export type ExportStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type ReportMode = 'DAY' | 'RANGE' | 'MONTH' | 'TIME_WINDOW';

/** Longest span one report may cover. */
export const REPORT_MAX_DAYS = 62;
/** A job nobody has polled for this long is cancelled (the progress window was closed). */
export const UNWATCHED_CANCEL_MS = 45_000;
/** Before the first screenshots are done, assume this many seconds each. */
export const ASSUMED_SEC_PER_SHOT = 0.12;
/** Rough bytes per screenshot inside a PDF (for the size shown before starting). */
export const ASSUMED_BYTES_PER_SHOT = 140_000;

export interface ReportPeriodInput {
  mode: ReportMode;
  date?: string;
  fromDate?: string;
  toDate?: string;
  month?: string;
  fromTime?: string;
  toTime?: string;
}

export interface ReportPeriod {
  fromDate: string;
  toDate: string;
  fromTime: string | null;
  toTime: string | null;
  /** Instants [from, to) the screenshots are taken from. */
  from: Date;
  to: Date;
  /** How the period reads on the report ("14 Oct 2026, 17:00 to 19:00"). */
  label: string;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function monthName(month: string): string {
  const m = MONTH.exec(month);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : month;
}

/** "14 Oct 2026" */
export function dayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

/** "Tue" for a day key. */
export function weekdayShort(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const iso = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  return WEEKDAYS[iso - 1];
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** First instant of a month in the business timezone. */
export function monthStart(month: string, tz: string): Date {
  return zonedMinutesToUtc(`${month}-01`, 0, tz);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The period of a report, or the problem with what was asked. */
export function reportPeriod(
  input: ReportPeriodInput,
  tz: string,
  today: string,
): { ok: true; period: ReportPeriod } | { ok: false; message: string } {
  let fromDate: string;
  let toDate: string;
  let fromTime: string | null = null;
  let toTime: string | null = null;
  switch (input.mode) {
    case 'DAY':
    case 'TIME_WINDOW': {
      if (!input.date || !isValidDateKey(input.date)) return { ok: false, message: 'Pick a date.' };
      fromDate = toDate = input.date;
      if (input.mode === 'TIME_WINDOW') {
        if (
          !input.fromTime ||
          !input.toTime ||
          !isValidHm(input.fromTime) ||
          !isValidHm(input.toTime)
        ) {
          return { ok: false, message: 'Pick a start and an end time like 17:00.' };
        }
        if (hmToMinutes(input.toTime) <= hmToMinutes(input.fromTime)) {
          return { ok: false, message: 'The end time must be after the start time.' };
        }
        fromTime = input.fromTime;
        toTime = input.toTime;
      }
      break;
    }
    case 'RANGE': {
      if (
        !input.fromDate ||
        !input.toDate ||
        !isValidDateKey(input.fromDate) ||
        !isValidDateKey(input.toDate)
      ) {
        return { ok: false, message: 'Pick the first and the last day.' };
      }
      if (input.toDate < input.fromDate) {
        return { ok: false, message: 'The last day must not be before the first.' };
      }
      if (daysBetween(input.fromDate, input.toDate) + 1 > REPORT_MAX_DAYS) {
        return { ok: false, message: `Pick at most ${REPORT_MAX_DAYS} days.` };
      }
      fromDate = input.fromDate;
      toDate = input.toDate;
      break;
    }
    case 'MONTH': {
      if (!input.month || !MONTH.test(input.month)) return { ok: false, message: 'Pick a month.' };
      fromDate = `${input.month}-01`;
      toDate = lastDayOfMonth(input.month);
      break;
    }
    default:
      return { ok: false, message: 'Pick a report type.' };
  }
  if (fromDate > today) return { ok: false, message: 'That period has not started yet.' };
  const from = zonedMinutesToUtc(fromDate, fromTime ? hmToMinutes(fromTime) : 0, tz);
  const to = toTime
    ? zonedMinutesToUtc(toDate, hmToMinutes(toTime), tz)
    : zonedMinutesToUtc(addDaysToKey(toDate, 1), 0, tz);
  let label: string;
  if (input.mode === 'MONTH') label = monthName(input.month as string);
  else if (fromTime && toTime) label = `${dayLabel(fromDate)}, ${fromTime} to ${toTime}`;
  else if (fromDate === toDate) label = dayLabel(fromDate);
  else label = `${dayLabel(fromDate)} to ${dayLabel(toDate)}`;
  return { ok: true, period: { fromDate, toDate, fromTime, toTime, from, to, label } };
}

// ---- Names inside the files --------------------------------------------------------

/** A folder or file name safe on Windows, macOS and Linux. */
export function safeName(text: string | null | undefined, fallback: string): string {
  const cleaned = (text ?? '')
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return cleaned.length ? cleaned : fallback;
}

/** "rx-vision-screenshots-asha-rao-2026-10-14.pdf" */
export function reportFileName(
  personName: string,
  period: Pick<ReportPeriod, 'fromDate' | 'toDate' | 'fromTime' | 'toTime'>,
): string {
  const slug =
    personName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'person';
  const when =
    period.fromDate === period.toDate
      ? period.fromDate +
        (period.fromTime
          ? `-${period.fromTime.replace(':', '')}-${period.toTime?.replace(':', '')}`
          : '')
      : `${period.fromDate}-to-${period.toDate}`;
  return `rx-vision-screenshots-${slug}-${when}.pdf`;
}

/** "rx-vision-screenshots-2026-01.zip" */
export function archiveFileName(month: string): string {
  return `rx-vision-screenshots-${month}.zip`;
}

/**
 * Folder names for each person in the archive: "<Month>/<Department>/<Employee>".
 * Two people with the same name in one department get "(2)", "(3)".
 */
export function archiveFolders(
  month: string,
  people: { id: string; name: string; department: string | null }[],
): Map<string, string> {
  const root = `${month} ${monthName(month).split(' ')[0]}`;
  const out = new Map<string, string>();
  const used = new Map<string, number>();
  const sorted = [...people].sort(
    (a, b) =>
      (a.department ?? '').localeCompare(b.department ?? '') ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  for (const p of sorted) {
    const dept = safeName(p.department, 'No department');
    const base = safeName(p.name, 'Unnamed');
    const key = `${dept}/${base}`.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    out.set(p.id, `${root}/${dept}/${n === 1 ? base : `${base} (${n})`}`);
  }
  return out;
}

/** "2026-01-05 Mon.pdf" */
export function dayFileName(dateKey: string): string {
  return `${dateKey} ${weekdayShort(dateKey)}.pdf`;
}

// ---- Progress -------------------------------------------------------------------------

export interface ProgressView {
  /** 0 to 1. */
  fraction: number;
  /** Seconds still to go (null until it can be told). */
  etaSec: number | null;
  /** Seconds since it started. */
  elapsedSec: number;
}

export function progressOf(input: {
  status: ExportStatus;
  total: number;
  done: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  now: Date;
}): ProgressView {
  const fraction =
    input.status === 'DONE' ? 1 : input.total > 0 ? Math.min(1, input.done / input.total) : 0;
  const end = input.finishedAt ?? input.now;
  const elapsedSec = input.startedAt
    ? Math.max(0, (end.getTime() - input.startedAt.getTime()) / 1000)
    : 0;
  let etaSec: number | null = null;
  if (input.status === 'QUEUED') etaSec = Math.round(input.total * ASSUMED_SEC_PER_SHOT);
  else if (input.status === 'RUNNING') {
    const left = Math.max(0, input.total - input.done);
    // A measured rate once a few have gone; the assumption before that.
    const rate = input.done >= 5 && elapsedSec > 0 ? elapsedSec / input.done : ASSUMED_SEC_PER_SHOT;
    etaSec = Math.round(left * rate + (left > 0 ? 2 : 1));
  } else etaSec = 0;
  return { fraction, etaSec, elapsedSec: Math.round(elapsedSec) };
}

// ---- Deleting a month -------------------------------------------------------------------

export interface ArchiveFacts {
  id: string;
  status: ExportStatus;
  complete: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  downloadedAt: Date | null;
  coveredUntil: Date | null;
}

export type PurgeBlock =
  | 'MONTH_NOT_ENDED'
  | 'NO_ARCHIVE'
  | 'ARCHIVE_BEFORE_MONTH_END'
  | 'ARCHIVE_INCOMPLETE'
  | 'ARCHIVE_NOT_DOWNLOADED'
  | 'NOTHING_TO_DELETE';

export const PURGE_BLOCK_TEXT: Record<PurgeBlock, string> = {
  MONTH_NOT_ENDED: 'A month can be deleted only after it has ended.',
  NO_ARCHIVE: 'Create the archive of this month first.',
  ARCHIVE_BEFORE_MONTH_END:
    'The archive was made before the month ended. Create a new archive now that it has.',
  ARCHIVE_INCOMPLETE: 'The archive did not finish. Create it again.',
  ARCHIVE_NOT_DOWNLOADED: 'Download the archive and keep it safe before deleting.',
  NOTHING_TO_DELETE: 'Nothing of this month is left to delete.',
};

/**
 * The archive that allows deleting `month`: the newest DONE, complete archive
 * started on or after the first instant of the next month. Null when there is none.
 */
export function qualifyingArchive(
  month: string,
  archives: ArchiveFacts[],
  tz: string,
): ArchiveFacts | null {
  const after = monthStart(nextMonth(month), tz).getTime();
  const ok = archives
    .filter(
      (a) => a.status === 'DONE' && a.complete && a.startedAt && a.startedAt.getTime() >= after,
    )
    .sort((a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime());
  return ok[0] ?? null;
}

/** Whether `month` can be deleted now, and if not, why. */
export function purgeBlock(input: {
  month: string;
  currentMonth: string;
  archives: ArchiveFacts[];
  /** Screenshots of the month the qualifying archive holds (still stored). */
  deletable: number;
  tz: string;
}): { ok: true; archive: ArchiveFacts } | { ok: false; block: PurgeBlock } {
  if (input.month >= input.currentMonth) return { ok: false, block: 'MONTH_NOT_ENDED' };
  const done = input.archives.filter((a) => a.status === 'DONE');
  if (!done.length) return { ok: false, block: 'NO_ARCHIVE' };
  const after = monthStart(nextMonth(input.month), input.tz).getTime();
  const postMonth = done.filter((a) => a.startedAt && a.startedAt.getTime() >= after);
  if (!postMonth.length) return { ok: false, block: 'ARCHIVE_BEFORE_MONTH_END' };
  const archive = qualifyingArchive(input.month, input.archives, input.tz);
  if (!archive) return { ok: false, block: 'ARCHIVE_INCOMPLETE' };
  if (!archive.downloadedAt) return { ok: false, block: 'ARCHIVE_NOT_DOWNLOADED' };
  if (input.deletable <= 0) return { ok: false, block: 'NOTHING_TO_DELETE' };
  return { ok: true, archive };
}

/**
 * The month an admin should archive and delete next, and by when: a month's
 * screenshots are due by the end of the month after it (January by 1 March).
 */
export function archiveDue(month: string): { dueBy: string } {
  return { dueBy: `${nextMonth(nextMonth(month))}-01` };
}
