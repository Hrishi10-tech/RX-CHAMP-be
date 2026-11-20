import {
  archiveDue,
  archiveFolders,
  dayFileName,
  progressOf,
  purgeBlock,
  qualifyingArchive,
  reportFileName,
  reportPeriod,
  safeName,
  ArchiveFacts,
} from './screenshot-export';

const TZ = 'Asia/Kolkata';
const TODAY = '2026-11-02';

describe('reportPeriod (fix 6)', () => {
  it('one day: midnight to midnight in India', () => {
    const r = reportPeriod({ mode: 'DAY', date: '2026-10-14' }, TZ, TODAY);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.period.from.toISOString()).toBe('2026-10-13T18:30:00.000Z');
    expect(r.period.to.toISOString()).toBe('2026-10-14T18:30:00.000Z');
    expect(r.period.label).toBe('14 Oct 2026');
  });

  it('a time window on one date: 17:00 to 19:00', () => {
    const r = reportPeriod(
      { mode: 'TIME_WINDOW', date: '2026-10-14', fromTime: '17:00', toTime: '19:00' },
      TZ,
      TODAY,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.period.from.toISOString()).toBe('2026-10-14T11:30:00.000Z');
    expect(r.period.to.toISOString()).toBe('2026-10-14T13:30:00.000Z');
    expect(r.period.label).toBe('14 Oct 2026, 17:00 to 19:00');
  });

  it('several days and a whole month', () => {
    const range = reportPeriod(
      { mode: 'RANGE', fromDate: '2026-10-01', toDate: '2026-10-07' },
      TZ,
      TODAY,
    );
    if (!range.ok) throw new Error(range.message);
    expect(range.period.label).toBe('1 Oct 2026 to 7 Oct 2026');
    const month = reportPeriod({ mode: 'MONTH', month: '2026-02' }, TZ, TODAY);
    if (!month.ok) throw new Error(month.message);
    expect(month.period).toMatchObject({
      fromDate: '2026-02-01',
      toDate: '2026-02-28',
      label: 'February 2026',
    });
  });

  it('refuses what cannot be a report', () => {
    const bad = [
      { mode: 'TIME_WINDOW', date: '2026-10-14', fromTime: '19:00', toTime: '17:00' },
      { mode: 'RANGE', fromDate: '2026-10-07', toDate: '2026-10-01' },
      { mode: 'RANGE', fromDate: '2026-01-01', toDate: '2026-06-30' },
      { mode: 'DAY', date: '2026-12-01' },
      { mode: 'DAY' },
    ] as const;
    for (const b of bad) expect(reportPeriod(b, TZ, TODAY).ok).toBe(false);
  });
});

describe('names in the files', () => {
  it('keeps folder names safe on every system', () => {
    expect(safeName('Sales / North: "A"', 'x')).toBe('Sales North A');
    expect(safeName('   ', 'No department')).toBe('No department');
  });

  it('lays the archive out as Month/Department/Employee, with twins numbered', () => {
    const f = archiveFolders('2026-01', [
      { id: 'a', name: 'Asha Rao', department: 'Billing' },
      { id: 'b', name: 'Asha Rao', department: 'Billing' },
      { id: 'c', name: 'Ravi', department: null },
    ]);
    expect(f.get('a')).toBe('2026-01 January/Billing/Asha Rao');
    expect(f.get('b')).toBe('2026-01 January/Billing/Asha Rao (2)');
    expect(f.get('c')).toBe('2026-01 January/No department/Ravi');
    expect(dayFileName('2026-01-05')).toBe('2026-01-05 Mon.pdf');
  });

  it('names the report after the person and the period', () => {
    expect(
      reportFileName('Asha Rao', {
        fromDate: '2026-10-14',
        toDate: '2026-10-14',
        fromTime: '17:00',
        toTime: '19:00',
      }),
    ).toBe('rx-vision-screenshots-asha-rao-2026-10-14-1700-1900.pdf');
    expect(
      reportFileName('Asha Rao', {
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
        fromTime: null,
        toTime: null,
      }),
    ).toBe('rx-vision-screenshots-asha-rao-2026-10-01-to-2026-10-31.pdf');
  });
});

describe('deleting a month (fix 7)', () => {
  const archive = (over: Partial<ArchiveFacts>): ArchiveFacts => ({
    id: 'a1',
    status: 'DONE',
    complete: true,
    // 3 Feb 2026, 10:00 IST: after January ended.
    startedAt: new Date('2026-02-03T04:30:00.000Z'),
    finishedAt: new Date('2026-02-03T05:00:00.000Z'),
    downloadedAt: new Date('2026-02-03T05:10:00.000Z'),
    coveredUntil: new Date('2026-02-03T04:30:00.000Z'),
    ...over,
  });
  const base = { month: '2026-01', currentMonth: '2026-02', deletable: 900, tz: TZ };

  it('allows it after the month ended, with a complete, downloaded archive made after it', () => {
    expect(purgeBlock({ ...base, archives: [archive({})] })).toMatchObject({ ok: true });
  });

  it('never while the month is running', () => {
    expect(purgeBlock({ ...base, currentMonth: '2026-01', archives: [archive({})] })).toEqual({
      ok: false,
      block: 'MONTH_NOT_ENDED',
    });
  });

  it('an archive made before the month ended does not count (31 Jan 23:59 IST)', () => {
    const early = archive({ startedAt: new Date('2026-01-31T18:29:00.000Z') });
    expect(purgeBlock({ ...base, archives: [early] })).toEqual({
      ok: false,
      block: 'ARCHIVE_BEFORE_MONTH_END',
    });
    // 1 Feb 00:00 IST is after.
    const onTime = archive({ startedAt: new Date('2026-01-31T18:30:00.000Z') });
    expect(qualifyingArchive('2026-01', [onTime], TZ)?.id).toBe('a1');
  });

  it('needs a finished, complete, downloaded archive, and something to delete', () => {
    expect(purgeBlock({ ...base, archives: [] })).toEqual({ ok: false, block: 'NO_ARCHIVE' });
    expect(purgeBlock({ ...base, archives: [archive({ complete: false })] })).toEqual({
      ok: false,
      block: 'ARCHIVE_INCOMPLETE',
    });
    expect(purgeBlock({ ...base, archives: [archive({ downloadedAt: null })] })).toEqual({
      ok: false,
      block: 'ARCHIVE_NOT_DOWNLOADED',
    });
    expect(purgeBlock({ ...base, deletable: 0, archives: [archive({})] })).toEqual({
      ok: false,
      block: 'NOTHING_TO_DELETE',
    });
  });

  it('January is due by 1 March', () => {
    expect(archiveDue('2026-01')).toEqual({ dueBy: '2026-03-01' });
    expect(archiveDue('2026-12')).toEqual({ dueBy: '2027-02-01' });
  });
});

describe('progress and time left', () => {
  const now = new Date('2026-11-02T10:00:00.000Z');
  it('measures the rate once a few screenshots are done', () => {
    const p = progressOf({
      status: 'RUNNING',
      total: 100,
      done: 25,
      startedAt: new Date(now.getTime() - 10_000),
      finishedAt: null,
      now,
    });
    expect(p.fraction).toBe(0.25);
    expect(p.etaSec).toBe(32);
    expect(p.elapsedSec).toBe(10);
  });

  it('is whole when done, and estimates before the start', () => {
    expect(
      progressOf({ status: 'DONE', total: 0, done: 0, startedAt: null, finishedAt: null, now })
        .fraction,
    ).toBe(1);
    expect(
      progressOf({ status: 'QUEUED', total: 100, done: 0, startedAt: null, finishedAt: null, now })
        .etaSec,
    ).toBe(12);
  });
});
